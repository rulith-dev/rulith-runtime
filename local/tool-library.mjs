// SPDX-License-Identifier: Apache-2.0
/**
 * This environment's tools: what every Agent here can run, installed and edited once.
 *
 * An environment is one Local installation's manager state. Before this file each Agent's
 * profile held its own copy of everything a Worker is started with — tool definitions, MCP
 * services with their installed packages, and the vault of Source credentials — so adding the
 * same MCP server for a second Agent meant installing and configuring it again, and two copies
 * of one tool could quietly drift apart. The tools now live once in a library under the manager
 * directory (`<manager>/library`), and each Agent's Worker is composed from it at every start:
 *
 *   · **Tools and MCP services are shared by every Agent.** What an Agent's Worker advertises
 *     is its own tools plus every tool and service in the library. Advertising authorizes
 *     nothing: Console's lock on each Agent's Connection still decides what that Agent may call.
 *     A service's own credentials (the env or headers it was saved with) belong to that tool and
 *     travel with it into the composed vault.
 *   · **Keys are not copied anywhere.** The library's vault holds the environment's Source
 *     credentials. A composed vault never contains them: the Worker is handed the file's
 *     location and reads, from it, an entry for a Source the authority has bound to that Agent's
 *     Connection — so a key reaches a Worker when Console binds its Source, and only then
 *     (`grantedSourceContext` in the Worker). What it takes from the entry is secret material
 *     (a token, headers, a database DSN at the address that was granted) and nothing that says what
 *     the Source is or where or how it connects, so an Agent's entry that does say that (a url, a
 *     transport, a command) stays in that Agent's own vault when its tools move here. This is the
 *     one library path a Worker is given, and it is set here and nowhere else.
 *   · **Shared trust.** A tool's own credentials are not keys in that sense: they belong to the
 *     tool and travel with it into the composed vault of every Agent that uses the environment.
 *     So a tool's own credentials, installed in this environment, are available to the tool
 *     processes of every Agent that uses the environment; Rulith only sends each Agent the calls
 *     it is authorized for. Tools whose credentials some Agents must not reach belong in a
 *     separate environment (a separate manager directory, `RULITH_MANAGER_HOME`).
 *   · **What stays with the Agent** is what cannot be shared: script (`run`) tools, because a
 *     script resolves under that Agent's own Worker root so sharing its definition would not
 *     share its code; the workspace and its file-tool mode; its own non-secret Source locations;
 *     its Connection, its materials and its conversations.
 *
 * An Agent is on the library (`row.tools.source === 'library'`) or on its own files
 * (`'own'`, or no `tools` at all), and an Agent on its own files runs exactly the code it ran
 * before this existed. A new Agent starts on the library. An older one moves once, at the next
 * start of the workbench, if nothing about it would be lost or changed (`migrate`): its
 * definitions, services and keys are pooled with the others', and an Agent whose tool, service
 * or key differs from another's under the same name stays on its own files, with a notice, until
 * somebody makes the two agree — pooling can merge equal things, and refuses to choose between
 * different ones.
 *
 * 中文说明：每个 Agent 的 Worker 启动时由「自己的工具/来源」加上「本环境库里的全部工具和 MCP 服务」
 * 合成；库里的密钥（环境来源凭据）不复制进任何 Worker，只把文件位置交给 Worker，由 Worker 按网关
 * 授予的来源名读取，且只取其中的秘密材料（令牌、请求头、地址与授予一致的数据库 DSN），绝不取任何决定
 * 来源是什么、连到哪里、怎么连的字段（url、transport、command 等）；自己写了这些字段的条目留在该 Agent
 * 自己的密文库里。迁移只合并相同的东西，同名不同内容的 Agent 保持原样并提示，绝不替人选择。
 *
 * 共享信任规则：工具自带的凭据（MCP 服务的 env、headers、token）一旦装进本环境，使用本环境的每个 Agent
 * 的工具进程都能取得；Rulith 只把每个 Agent 被授权的调用交给它。凭据不该被某些 Agent 触及的工具，
 * 请放进另一个独立的环境（另一个管理目录，即另设 RULITH_MANAGER_HOME）。
 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { ENVIRONMENT_KEY_FIELDS, canonicalJson, configuredWorkerTools, workerToolManifest, workerToolsOf } from '../worker/rulith-worker.mjs'
import { createMcpServices, serviceIdentity } from './mcp-services.mjs'
import { createWorkerToolManagement } from './worker-tool-management.mjs'
import { writeJsonAtomic } from './manager-registry.mjs'

/** The marker file's format: its presence says a directory is an environment's tool library. */
export const LIBRARY_FORMAT = 'rulith-environment-tools/1'
/** The one variable that tells a Worker where the environment's keys are. Set by composition only. */
export const ENVIRONMENT_VAULT_VARIABLE = 'RULITH_ENVIRONMENT_SECRETS_FILE'
export const SCRIPT_TOOL_NOTE = 'A script tool runs files from one Agent\'s own folder, so it stays with that Agent. Add it to that Agent\'s own tool file.'
const MANIFEST_FORMAT = 'rulith-worker-tools/1'
const SERVICES_FORMAT = 'rulith-local-mcp/1'
/** Where an Agent's backed-up files go when its tools move into the environment. */
const BACKUP_DIRECTORY = 'tools-before-environment'
/**
 * How long after a failed removal of a Worker's composed files to try again, once per entry: the
 * same spacing a Worker's own restarts use. Windows can hold a file open for a moment (a virus
 * scanner, an indexer), which is a delay and not a verdict, and four tries cover its ordinary length.
 */
const DISCARD_RETRY_MS = Object.freeze([250, 1000, 4000, 10_000])

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const emptyManifest = () => ({ format: MANIFEST_FORMAT, tools: {} })
const same = (left, right) => canonicalJson(left) === canonicalJson(right)
const inside = (root, target) => { const rel = relative(resolve(root), resolve(target)); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) }
/** Entries added up without ever assigning to a key an object might treat as an instruction. */
const entriesOf = (map) => Object.fromEntries(map)

/**
 * A JSON file as it is, or `fallback` when there is none.
 *
 * A file that exists and cannot be parsed is a refusal that names it, never an empty value: reading
 * "no tools" out of a damaged file and then writing over it is how a person loses their keys. The
 * message says nothing about *where* parsing failed, because the text a parser quotes can be a
 * piece of a credential.
 */
function readStrict(file, fallback) {
  if (!existsSync(file)) return fallback
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch {
    throw new Error(`${file} is not valid JSON. Nothing was changed, and Rulith never repairs or overwrites a file it cannot read.`
      + ' Repair or move it, then try again.')
  }
}

/** Does this vault entry hold a credential, or only say where something is? */
export function secretBearing(source) {
  if (!record(source)) return false
  if ((typeof source.dsn === 'string' && source.dsn !== '') || (typeof source.token === 'string' && source.token !== '')) return true
  if (['headers', 'env'].some((field) => record(source[field]) && Object.keys(source[field]).length > 0)) return true
  return ['url', 'access'].some((field) => {
    try { const url = new URL(source[field]); return url.username !== '' || url.password !== '' || url.search !== '' } catch { return false }
  })
}

/**
 * The tools and Sources a library holds, in the form one Worker receives them.
 *
 * Every tool in the library's manifest, every service's tools, and every service's own Source
 * (with its credentials, which belong to it). The library's vault is not here: keys are never
 * composed. `scratchFor`, when given, names the folder an Agent uses in place of the shared
 * discovery scratch a registry service was saved with, so two Agents never share a working
 * directory.
 */
function sharedInputs(snapshot, { libraryScratch, scratchFor } = {}) {
  const tools = new Map(), vault = new Map(), scratch = []
  const add = (id, definition) => {
    if (tools.has(id)) throw new Error(`${id} appears twice in this environment's tools.`)
    tools.set(id, definition)
  }
  for (const [id, definition] of Object.entries(snapshot.manifest.tools)) {
    if (definition?.adapter === 'run') throw new Error(`${id} is a script tool. ${SCRIPT_TOOL_NOTE}`)
    add(id, definition)
  }
  for (const service of snapshot.services) {
    for (const [id, definition] of Object.entries(service.tools)) add(id, definition)
    let source = service.source
    if (scratchFor !== undefined && typeof source?.cwd === 'string' && inside(libraryScratch(service.name), source.cwd)
      && inside(source.cwd, libraryScratch(service.name))) {
      const own = scratchFor(service.name)
      source = { ...source, cwd: own }
      scratch.push(own)
    }
    vault.set(service.name, source)
  }
  return { tools: entriesOf(tools), vault: entriesOf(vault), scratch }
}

/**
 * One Agent's own inputs plus the environment's, checked the way its Worker will check them.
 *
 * The same entry on both sides is one entry. A *different* entry under the same ID or name is a
 * fault and is never resolved by choosing one: the Agent keeps what it has, nothing is overwritten,
 * and the message names what differs. What is left is run through the Worker's own composition
 * (`configuredWorkerTools` and `workerToolManifest`: the manifest shape, duplicate handlers, the
 * built-in collisions of this Agent's file-tool mode, the advertisement ceiling), because a
 * Worker that refuses its tools at start has not failed in any way its Agent can explain.
 *
 * Pure but for what the Worker's functions throw; the digest covers exactly what is written to
 * the Worker's two files, so two compositions with the same digest start the same Worker.
 */
function compose({ own, shared, environment }) {
  const tools = new Map(Object.entries(own.tools)), vault = new Map(Object.entries(own.vault)), differing = []
  for (const [id, definition] of Object.entries(shared.tools)) {
    if (!tools.has(id)) tools.set(id, definition)
    else if (!same(tools.get(id), definition)) differing.push(id)
  }
  for (const [name, source] of Object.entries(shared.vault)) {
    if (!vault.has(name)) vault.set(name, source)
    else if (!same(vault.get(name), source)) differing.push(name)
  }
  if (differing.length) {
    throw new Error(`${differing.join(', ')} ${differing.length === 1 ? 'differs' : 'differ'} from the tool or Source of the same`
      + ' name in this Agent\'s own files. Change one side so that they match.')
  }
  const manifest = { format: MANIFEST_FORMAT, tools: entriesOf(tools) }
  const advertised = workerToolManifest(configuredWorkerTools(manifest, String(environment.RULITH_WORKSPACE_TOOLS ?? 'read').trim(),
    String(environment.RULITH_MATERIALS_ROOT ?? '')))
  return { manifest, vault: entriesOf(vault), digest: createHash('sha256').update(canonicalJson({ advertised, tools: manifest.tools, vault: entriesOf(vault) })).digest('hex') }
}

/** One path that may sit under `from`, moved to sit under `to`; anything else is returned unchanged. */
const rebasePath = (value, from, to) => {
  if (typeof value !== 'string' || !isAbsolute(value) || !inside(from, value)) return value
  return join(to, relative(resolve(from), resolve(value)))
}

/**
 * @param {object} options
 * @param {ReturnType<import('./manager-registry.mjs').createManagerRegistry>} options.registry
 * @param {Map<string, {host: object}>} options.hosts   The instance manager's open hosts.
 * @param {(directory: string) => object} options.loadConfig  An instance's `local.json`, with defaults.
 * @param {readonly number[]} [options.retryDelaysMs]  Spacing of the tries to remove a Worker's composed files.
 */
export function createToolLibrary({ registry, hosts, loadConfig, retryDelaysMs = DISCARD_RETRY_MS }) {
  const root = join(registry.root, 'library')
  const paths = { marker: join(root, 'library.json'), tools: join(root, 'worker-tools.json'), vault: join(root, 'worker-secrets.json'),
    services: join(root, 'mcp', 'services.json'), packages: join(root, 'mcp', 'packages'), scratch: (name) => join(root, 'mcp', 'workspaces', name) }
  /**
   * The environment the library is validated under: the strictest set of built-in tools there is
   * (every workspace write tool, and the material tools), so that anything it accepts also
   * composes in any Agent's Worker without colliding with a built-in.
   */
  const context = () => ({ directory: root, environment: { RULITH_TOOLS_FILE: paths.tools, RULITH_SECRETS_FILE: paths.vault,
    RULITH_WORKSPACE_TOOLS: 'read-write', RULITH_MATERIALS_ROOT: join(root, 'materials') } })
  // The manager directory holds the device credential and every Agent's files, so no server saved
  // here may be pointed at it. What the guard permits inside this tree is `mcp/packages` (the
  // library's own installs) and `mcp/workspaces` (discovery scratch, no credentials).
  const mcp = createMcpServices(paths.marker, { protectedPaths: [registry.root], workerContext: context })
  const management = createWorkerToolManagement({ mcpServices: mcp, workerContext: context,
    setWorkspaceMode: () => { throw new Error('File tools are set for each Agent, not for the environment.') },
    refuse: (definition) => { if (definition?.adapter === 'run') throw new Error(SCRIPT_TOOL_NOTE) } })
  /** The digest each running Worker was started with, to tell which ones a library change affects. */
  const startedWith = new Map(), probes = new Map()
  /** The two files composition wrote for an Agent's Worker, remembered so that removing them needs only their paths. */
  const composedAt = new Map()
  /** Composed files that would not go when their Worker did, by Agent: where they are, and the timer of the next try. */
  const unremoved = new Map()

  const rowOf = (id) => registry.instance(id)
  const need = (id) => { const row = rowOf(id); if (row === undefined) throw new Error(`No local instance ${id} is registered.`); return row }
  const agentOf = (row) => row.agentName || row.name
  const onLibrary = (row) => row?.tools?.source === 'library'
  const usedBy = () => registry.read().instances.filter(onLibrary).map(agentOf)
  const lane = (row) => { const directory = join(resolve(row.directory), 'environment')
    return { directory, tools: join(directory, 'worker-tools.json'), vault: join(directory, 'worker-secrets.json'), work: (name) => join(directory, 'work', name) } }

  // ── Removing what a Worker was composed into ────────────────────────────────────────────

  /** Is this Agent's Worker running now? When that cannot be told, yes: nothing is removed from under a Worker on a guess. */
  const workerRunning = (id) => { try { return hosts.get(id)?.host.status().worker === true } catch { return true } }
  /**
   * Remove the two files composition wrote for one Worker, and say which would not go.
   *
   * The vault goes first, because it is the one that holds credentials, and each file is tried
   * whatever happened to the other: a failure on one must not leave the other behind.
   */
  const removeComposed = (files) => {
    const failed = []
    for (const file of [files.vault, files.tools]) {
      try { rmSync(file, { force: true }) } catch (error) { failed.push({ file, code: String(error?.code ?? 'unknown') }) }
    }
    return failed
  }
  const cancelDiscard = (id) => { clearTimeout(unremoved.get(id)?.timer); unremoved.delete(id) }
  /** Say which composed files would not go, by name and by the system's own code, and what to do. Once per give-up, never with a file's content. */
  const reportUnremoved = (failed) => {
    const many = failed.length > 1, them = many ? 'them' : 'it'
    console.error(`· Rulith could not remove ${failed.map(({ file }) => file).join(' and ')} (${failed.map(({ code }) => code).join(', ')}).`
      + ` ${many ? 'They were' : 'It was'} written for a Worker that has stopped and may hold service credentials. Delete ${them} once nothing else is using ${them}.`)
  }
  /**
   * Remove an Agent's composed files; if some will not go, try again a few times, then say so.
   *
   * These files hold the credentials of this environment's services and have no use once their
   * Worker is gone, so one that cannot be removed now is not left to chance. A try never touches
   * files whose Agent has a Worker running again (that Worker was composed into the same paths and
   * is using them), and nothing thrown inside a timer reaches the process.
   */
  const discard = (id, files, attempt = 0) => {
    cancelDiscard(id)
    const failed = removeComposed(files)
    if (failed.length === 0) return
    const last = attempt >= retryDelaysMs.length
    const timer = last ? undefined : setTimeout(() => {
      try {
        if (workerRunning(id)) { unremoved.delete(id); return }
        discard(id, files, attempt + 1)
      } catch { /* the next time this Agent's Worker stops, or the workbench closes, tries again */ }
    }, retryDelaysMs[attempt])
    timer?.unref?.()
    unremoved.set(id, { files, timer, reported: last })
    if (last) reportUnremoved(failed)
  }

  /** Every library file this code reads is checked first, so a damaged one is named and nothing else moves. */
  const preflight = (files = [paths.marker, paths.tools, paths.services, paths.vault]) => {
    for (const file of files) readStrict(file, undefined)
    const marker = readStrict(paths.marker, undefined)
    if (marker !== undefined && marker?.format !== LIBRARY_FORMAT) {
      throw new Error(`${paths.marker} is not a ${LIBRARY_FORMAT} marker. Nothing was changed. Move that directory aside, or restore the marker, then try again.`)
    }
    if (!record(readStrict(paths.vault, {}))) throw new Error(`${paths.vault} must be a JSON object. Nothing was changed.`)
  }
  const markLibrary = () => {
    if (!existsSync(paths.marker)) writeJsonAtomic(paths.marker, { format: LIBRARY_FORMAT })
    if (!existsSync(paths.vault)) writeJsonAtomic(paths.vault, {})
  }
  const snapshot = () => {
    preflight()
    const manifest = readStrict(paths.tools, emptyManifest())
    workerToolsOf(manifest)
    return { manifest, services: mcp.rows() }
  }

  /**
   * Compose one Agent's Worker inputs from its own (`readOwn()`, read inside the same refusal) and
   * the library's. `prepare` creates the folders the composition will use.
   */
  const composed = (id, readOwn, environment, { prepare = false } = {}) => {
    const row = need(id)
    try {
      const library = snapshot()
      for (const service of library.services) mcp.assertLaunch(service)
      const shared = sharedInputs(library, { libraryScratch: paths.scratch, scratchFor: lane(row).work })
      const result = compose({ own: readOwn(), shared, environment })
      if (prepare) for (const directory of shared.scratch) mkdirSync(directory, { recursive: true, mode: 0o700 })
      return result
    } catch (error) {
      throw new Error(`This environment's tools cannot be loaded for ${agentOf(row)}: ${error.message}`)
    }
  }
  /** An Agent's own tools and Sources, read from the two files its Worker would be given. */
  const ownFromFiles = (environment, directory) => {
    const manifest = readStrict(resolve(directory, environment.RULITH_TOOLS_FILE || './worker-tools.json'), emptyManifest())
    workerToolsOf(manifest)
    const vault = readStrict(resolve(directory, environment.RULITH_SECRETS_FILE || './worker-secrets.json'), {})
    if (!record(vault)) throw new Error('This Agent\'s Source vault must be a JSON object.')
    return { tools: manifest.tools, vault }
  }

  const setNotice = async (id, notice) => {
    const current = rowOf(id)?.tools
    if (current === undefined || JSON.stringify(current.notice ?? null) === JSON.stringify(notice ?? null)) return
    await registry.patchInstance(id, (row) => {
      const { notice: _previous, ...rest } = row.tools
      return { tools: { ...rest, ...(notice === undefined ? {} : { notice }), updatedAt: new Date().toISOString() } }
    })
  }
  /**
   * Store, or with no notice take away, a note on an Agent, for a note that is not worth stopping
   * anything for: one that cannot be stored is said again at the next start, and must never turn
   * work that was done into work that was not.
   */
  const noteQuietly = async (id, notice) => { try { await setNotice(id, notice) } catch { /* said again at the next start */ } }

  /**
   * After the library changed: reload exactly the Workers whose tools changed, once their running
   * executions have drained, and leave every other Worker alone.
   *
   * Each Worker that is running on the library composes what it would start with now, without
   * writing anything. If that fails — a tool the Agent also has under the same name, a hundred and
   * twenty-nine tools — the Worker keeps running on what it has and the Agent is told why; if it
   * differs from what the Worker started with, the Worker is reloaded through the host's own
   * drain, which composes again at its start. A stopped Worker composes when it next starts.
   *
   * Each Agent is handled on its own and none of it can fail the caller. By the time this runs the
   * change is already saved, so a registry write that fails for one Agent (a notice that cannot be
   * stored) or a reload that cannot be started is not a failed save: the Agent is named in
   * `pending`, the others are still reloaded, and the caller says that the reload is pending.
   */
  const reloadAffected = async () => {
    const pending = []
    for (const [id, live] of [...hosts]) {
      let agent = id
      try {
        const row = rowOf(id)
        if (row !== undefined) agent = agentOf(row)
        if (!onLibrary(row) || !live.host.status().worker) continue
        let digest
        try { digest = live.host.toolsDigest() } catch (error) {
          await setNotice(id, { kind: 'failed', text: error.message })
          continue
        }
        // The reload is what matters. The notice that said it could not happen is tidied after it, and
        // quietly: a reload that was made is not pending because an old note could not be taken away.
        if (digest !== startedWith.get(id)) live.host.reloadWorker()
        if (row.tools.notice?.kind === 'failed') await noteQuietly(id)
      } catch { pending.push(agent) }
    }
    return { pending }
  }
  const REMEDY = 'Their running Workers keep the previous tools until they reload: turn "Use this environment’s tools and files" off and on for each, or any later change here retries it.'
  /** The sentence that says a change is made but some Workers have not picked it up; nothing when none is waiting. */
  const pendingNote = (pending, lead = 'Saved;') => (pending.length === 0 ? '' : ` ${lead} reload pending for ${pending.join(', ')}. ${REMEDY}`)
  /** What a save, a removal or an apply answers with: who is affected, after their running work. */
  const changed = async (result) => {
    const { pending } = await reloadAffected()
    let affected
    // The change is saved; being unable to list who uses the library is no reason to say it was not.
    try { affected = usedBy() } catch { affected = [] }
    return { ...result, affected,
      ...(pending.length === 0 ? {} : { reloadPending: pending, teaching: `${result.teaching ?? ''}${pendingNote(pending)}`.trim() }) }
  }
  // A revision includes private launch settings through a hash; credentials never reach the page.
  const revisionOf = (view) => createHash('sha256').update(canonicalJson({ revision: view.revision,
    services: mcp.rows().map(serviceIdentity) })).digest('hex')
  const review = (body, revision = body.revision) => {
    preflight()
    if (body.confirmed !== true) throw new Error('Review and confirm this change once before saving it.')
    const view = management.overview()
    if (!revision || revision !== revisionOf(view)) throw new Error("This environment's tools changed. Reopen this list before saving.")
    return { ...body, revision: view.revision }
  }

  // ── Moving an Agent's own tools into the library ─────────────────────────────────────────

  /** An Agent's own tool inputs as they stand on disk. */
  const readOwn = (row) => {
    const directory = resolve(row.directory), config = loadConfig(directory), env = config.worker?.env ?? {}
    const workerDirectory = dirname(config.paths?.worker ? resolve(directory, config.paths.worker) : resolve(import.meta.dirname, '../worker/rulith-worker.mjs'))
    const manifestFile = resolve(workerDirectory, env.RULITH_TOOLS_FILE || './worker-tools.json')
    const vaultFile = resolve(workerDirectory, env.RULITH_SECRETS_FILE || './worker-secrets.json')
    const manifest = readStrict(manifestFile, emptyManifest())
    workerToolsOf(manifest)
    const vault = readStrict(vaultFile, {})
    if (!record(vault)) throw new Error(`${vaultFile} must be a JSON object.`)
    const services = readStrict(join(directory, 'mcp', 'services.json'), { format: SERVICES_FORMAT, services: {} })
    if (services.format !== SERVICES_FORMAT || !record(services.services)) throw new Error(`${join(directory, 'mcp', 'services.json')} is not a Local MCP configuration.`)
    return { row, directory, environment: env, manifestFile, vaultFile, manifest, vault, services: services.services,
      // Only a file inside the Agent's own directory is the Agent's to move; one it was pointed at elsewhere is not.
      movable: { manifest: inside(directory, manifestFile), vault: inside(directory, vaultFile) } }
  }
  const unchanged = (own) => {
    const current = readOwn(own.row)
    if (current.manifestFile !== own.manifestFile || current.vaultFile !== own.vaultFile
      || !same(current.environment, own.environment) || !same(current.manifest, own.manifest)
      || !same(current.vault, own.vault) || !same(current.services, own.services)) {
      throw new Error(`${agentOf(own.row)}'s configuration changed during migration. Nothing was overwritten; check again.`)
    }
  }
  /** A service saved under an Agent's own MCP directory, as it will read once that directory's paths are the library's. */
  const rebased = (service, directory) => {
    const from = join(directory, 'mcp'), to = join(root, 'mcp'), source = service.source
    if (!record(source)) return service
    return { ...service, source: { ...source,
      ...(source.command === undefined ? {} : { command: rebasePath(source.command, from, to) }),
      ...(Array.isArray(source.args) ? { args: source.args.map((argument) => rebasePath(argument, from, to)) } : {}),
      ...(source.cwd === undefined ? {} : { cwd: rebasePath(source.cwd, from, to) }) } }
  }
  /**
   * Can this vault entry become one of the environment's keys? It holds a credential, and it says
   * nothing but what the Worker takes from an environment entry (`ENVIRONMENT_KEY_FIELDS`: what it
   * is for, a token, headers, a DSN). One that also states where or how to connect (a url or access,
   * a transport, a command, arguments, a folder) or anything else the environment ignores would be
   * refused or cut down there, so the Agent keeps it, where it works as it always did.
   */
  const poolable = (source) => secretBearing(source) && Object.keys(source).every((field) => ENVIRONMENT_KEY_FIELDS.includes(field))
  /**
   * What an Agent has that can move: definitions, services and the vault entries that hold
   * credentials the environment can carry. `kept` names the credential-bearing entries that stay.
   */
  const movables = (own) => ({
    tools: own.movable.manifest ? Object.fromEntries(Object.entries(own.manifest.tools).filter(([, definition]) => definition?.adapter !== 'run')) : {},
    services: Object.fromEntries(Object.entries(own.services).map(([name, service]) => [name, rebased(service, own.directory)])),
    keys: own.movable.vault ? Object.fromEntries(Object.entries(own.vault).filter(([, source]) => poolable(source))) : {},
    kept: own.movable.vault ? Object.entries(own.vault).filter(([, source]) => secretBearing(source) && !poolable(source)).map(([name]) => name) : [],
  })
  /** What an Agent keeps once those have moved: scripts, files that are not its own to move, locations. */
  const remaining = (own, take) => ({
    tools: own.manifest.tools,
    vault: Object.fromEntries(Object.entries(own.vault).filter(([name]) => !Object.hasOwn(take.keys, name))),
  })
  /**
   * Decide, before anything is written, which of these Agents can move into the library.
   *
   * Each Agent is added to a library that holds the Agents before it. Whatever it has that is
   * equal to something already there is merged; a tool, service or key that is *different* under
   * the same name, or a name used for two kinds of thing, keeps that Agent on its own files. Then
   * the library as it would stand is composed for every Agent that uses it, this one included,
   * and an Agent that would no longer start on it (a tool it also has as a script, two tools
   * claiming one kind of work, more than the Worker can advertise, a Source name used twice)
   * keeps its own files as well. The Agents already moved are therefore never disturbed by a
   * later one, and an Agent that moves has been shown to start.
   */
  const plan = (candidates, current, lanes) => {
    const library = { tools: { ...current.manifest.tools }, services: Object.fromEntries(current.services.map((service) => [service.name, service])),
      keys: { ...current.keys } }
    const moves = [], kept = []
    /** Everyone who starts on the library once the plan so far is carried out, with what each moved. */
    const users = lanes.map((own) => ({ own, take: { tools: {}, services: {}, keys: {}, kept: [] } }))
    /** Would every one of them, and `entry`, still start on a library that held `next`? If not, which and why. */
    const firstProblem = (next, entry) => {
      let shared
      try {
        for (const service of Object.values(next.services)) mcp.assertLaunch(service)
        configuredWorkerTools({ format: MANIFEST_FORMAT, tools: next.tools }, 'read-write', join(root, 'materials'))
        shared = sharedInputs({ manifest: { tools: next.tools }, services: Object.values(next.services) })
      } catch (error) { return error.message }
      for (const other of [...users, entry]) {
        try {
          // Checked as the Worker will start: its own file-tool mode, and a material area, which adds built-in tools.
          compose({ own: remaining(other.own, other.take), shared,
            environment: { ...other.own.environment, RULITH_MATERIALS_ROOT: join(other.own.directory, 'materials') } })
        } catch (error) {
          return other === entry ? error.message : `adding its tools would stop ${agentOf(other.own.row)} from starting: ${error.message}`
        }
      }
      return undefined
    }
    for (const own of candidates) {
      const take = movables(own), clashes = new Set()
      for (const [id, definition] of Object.entries(take.tools)) if (Object.hasOwn(library.tools, id) && !same(library.tools[id], definition)) clashes.add(id)
      for (const [name, service] of Object.entries(take.services)) {
        const old = library.services[name]
        // One name is one thing: a service and a key (or two services) cannot both be called `name`.
        if ((old !== undefined && serviceIdentity(old) !== serviceIdentity(service)) || Object.hasOwn(library.keys, name) || Object.hasOwn(take.keys, name)) clashes.add(name)
      }
      for (const [name, source] of Object.entries(take.keys)) {
        if ((Object.hasOwn(library.keys, name) && !same(library.keys[name], source)) || Object.hasOwn(library.services, name)) clashes.add(name)
      }
      const ids = [...clashes]
      if (ids.length) {
        kept.push({ own, ids, reason: `${ids.join(', ')} ${ids.length === 1 ? 'differs' : 'differ'} from this environment's tools with the same ID.` })
        continue
      }
      const next = { tools: { ...library.tools, ...take.tools }, services: { ...library.services, ...take.services }, keys: { ...library.keys, ...take.keys } }
      const entry = { own, take }, problem = firstProblem(next, entry)
      if (problem !== undefined) { kept.push({ own, ids: [], reason: problem }); continue }
      Object.assign(library, next)
      users.push(entry)
      moves.push(entry)
    }
    return { moves, kept }
  }

  const libraryState = () => { preflight([paths.marker, paths.tools, paths.services, paths.vault])
    return { manifest: readStrict(paths.tools, emptyManifest()), services: mcp.rows(), keys: readStrict(paths.vault, {}) } }
  /** A sentence always ends: an error's own message may or may not, and a notice is built from several. */
  const sentence = (text) => (/[.!?]$/.test(String(text)) ? String(text) : `${text}.`)
  /** Does the folder an Agent's originals were backed up to hold keys or service credentials? */
  const backupKeepsSecrets = (own) => ['worker-secrets.json', 'services.json'].some((name) => existsSync(join(own.directory, BACKUP_DIRECTORY, name)))
  const notices = {
    conflict: (row, reason, fix = 'Remove or change one side, then check again.') => ({ kind: 'conflict', text: `${agentOf(row)} keeps its own tools for now: ${reason} ${fix}` }),
    /**
     * `secrets` says the backup holds keys or service credentials. It does, in plain text: the backup is the
     * files the move rewrote or removed, exactly as they were, so it is the one copy that outlives the move, and
     * its owner is told. `moved` is false when nothing moved (and so nothing was backed up), and `take.kept` names
     * the credential-bearing entries that did not move, because they say where or how to connect.
     */
    moved: (own, take, { moved = true,
      secrets = Object.keys(take.keys).length > 0 || Object.values(take.services).some((service) => secretBearing(service.source)) } = {}) => {
      const kept = take.kept ?? []
      return { kind: 'moved',
        text: (moved ? `Moved this Agent's tools into this environment. Old files are in ${join(own.directory, BACKUP_DIRECTORY)}.` : 'This Agent now uses this environment\'s tools.')
          + (Object.keys(take.keys).length ? ' Its keys now live in this environment; a key is used only for a Source bound to the Agent in Console, at the address granted there.' : '')
          + (kept.length ? ` Kept in this Agent's own vault, because ${kept.length === 1 ? 'it says' : 'they say'} where or how to connect and an environment key cannot: ${kept.join(', ')}.` : '')
          + (secrets ? ' That folder keeps the old keys and service credentials as they were; delete it when you no longer need it.' : '') }
    },
    /** The move is made, but old files are still where this Agent's Worker would read them, and it may refuse to start for that. */
    untidy: (own, reason) => ({ kind: 'untidy', text: `${agentOf(own.row)} now uses this environment's tools, but its old files could not all be removed: ${sentence(reason)}`
      + ` Until they are, its Worker may refuse to start because the old copies differ from the environment's. Fix that (for example, close whatever is using ${own.directory}), then Check again.`
      + ' Starting the workbench again retries it too.' }),
  }

  /** The files that the library must hold before an Agent may be recorded as moved. */
  const writeLibrary = (own, take) => {
    unchanged(own)
    // Registry writes yield between Agents. A page may have changed the library since planning;
    // never replace that confirmed edit with an older definition from the migration plan.
    const current = libraryState()
    const tools = sharedInputs(current).tools
    for (const [id, definition] of Object.entries(take.tools)) {
      if (Object.hasOwn(tools, id) && !same(tools[id], definition)) throw new Error(`${id} changed during migration. Check again.`)
    }
    for (const [name, source] of Object.entries(take.keys)) {
      if (current.services.some(service => service.name === name)
        || (Object.hasOwn(current.keys, name) && !same(current.keys[name], source))) throw new Error(`${name} changed during migration. Check again.`)
    }
    for (const service of Object.values(take.services)) {
      const saved = current.services.find(row => row.name === service.name)
      if (Object.hasOwn(current.keys, service.name) || (saved && serviceIdentity(saved) !== serviceIdentity(service))) throw new Error(`${service.name} changed during migration. Check again.`)
    }
    // Packages are copied, not moved: until the row says "library" the Agent may still need its own
    // copy, and a copy that is interrupted must never look like an install. The Agent's directory is
    // dropped afterwards, which is what makes it a move.
    const source = join(own.directory, 'mcp', 'packages')
    if (existsSync(source)) {
      mkdirSync(paths.packages, { recursive: true, mode: 0o700 })
      for (const entry of readdirSync(source, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.install-') || existsSync(join(paths.packages, entry.name))) continue
        const staging = join(paths.packages, `.copy-${process.pid}-${Date.now()}-${entry.name}`)
        try { cpSync(join(source, entry.name), staging, { recursive: true }); renameSync(staging, join(paths.packages, entry.name)) } finally { rmSync(staging, { recursive: true, force: true }) }
      }
    }
    markLibrary()
    mcp.merge(Object.values(take.services))
    const manifest = readStrict(paths.tools, emptyManifest())
    if (Object.keys(take.tools).some((id) => !Object.hasOwn(manifest.tools, id))) {
      writeJsonAtomic(paths.tools, { format: MANIFEST_FORMAT, tools: { ...manifest.tools, ...take.tools } })
    }
    const vault = readStrict(paths.vault, {})
    if (Object.keys(take.keys).some((name) => !Object.hasOwn(vault, name))) writeJsonAtomic(paths.vault, { ...vault, ...take.keys })
  }
  /**
   * Tidy an Agent's own directory once the library holds everything that moved.
   *
   * Idempotent, so an interruption anywhere in it is finished by the next run. The originals of
   * what is about to be rewritten or removed are copied aside first and never overwritten (the
   * directory is renamed into place only when its copy is complete), the Agent's own files are
   * rewritten without what moved, its scratch folders keep their contents under the new place, and
   * its MCP directory — packages already in the library, caches, generated projections — is dropped.
   * A file this does not change is not copied: it is not the original of anything, and copying a
   * vault whose keys all stayed would only put another copy of them on disk.
   */
  const tidy = (own, take) => {
    unchanged(own)
    const moved = (own.movable.manifest ? Object.keys(take.tools) : []).filter((id) => Object.hasOwn(own.manifest.tools, id))
    const keys = Object.keys(take.keys).filter((name) => Object.hasOwn(own.vault, name))
    const backup = join(own.directory, BACKUP_DIRECTORY)
    if (!existsSync(backup)) {
      const staging = backup + '.tmp'
      rmSync(staging, { recursive: true, force: true })
      const keep = (file, name) => { if (existsSync(file)) { mkdirSync(staging, { recursive: true, mode: 0o700 }); writeFileSync(join(staging, name), readFileSync(file), { mode: 0o600 }) } }
      if (moved.length) keep(own.manifestFile, 'worker-tools.json')
      if (keys.length) keep(own.vaultFile, 'worker-secrets.json')
      keep(join(own.directory, 'mcp', 'services.json'), 'services.json')
      if (existsSync(staging)) renameSync(staging, backup)
    }
    if (moved.length) writeJsonAtomic(own.manifestFile, { format: MANIFEST_FORMAT, tools: Object.fromEntries(Object.entries(own.manifest.tools).filter(([id]) => !moved.includes(id))) })
    if (keys.length) writeJsonAtomic(own.vaultFile, Object.fromEntries(Object.entries(own.vault).filter(([name]) => !keys.includes(name))))
    const scratch = join(own.directory, 'mcp', 'workspaces')
    if (existsSync(scratch)) {
      for (const entry of readdirSync(scratch, { withFileTypes: true })) {
        const target = lane(own.row).work(entry.name)
        if (entry.isDirectory() && !existsSync(target)) { mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); renameSync(join(scratch, entry.name), target) }
      }
    }
    rmSync(join(own.directory, 'mcp'), { recursive: true, force: true })
  }

  /** Move these Agents' tools into the library if every one of them can; say why for each one that cannot. */
  const migrate = async (rows) => {
    const state = libraryState()
    const lanes = registry.read().instances.filter(onLibrary).flatMap((row) => { try { return [readOwn(row)] } catch { return [] } })
    const candidates = [], unreadable = []
    for (const row of rows) { try { candidates.push(readOwn(row)) } catch (error) { unreadable.push({ row, reason: error.message }) } }
    const { moves, kept } = plan(candidates, state, lanes)
    const outcome = { moved: [], untidy: [], kept: [
      ...unreadable.map(({ row, reason }) => ({ row, reason, ids: [], fix: 'Then check again.' })),
      ...kept.map(({ own, reason, ids }) => ({ row: own.row, reason, ids })) ] }
    for (const { row, reason, ids, fix } of outcome.kept) {
      const notice = notices.conflict(row, reason, fix)
      const current = rowOf(row.id)?.tools
      if (current?.source === 'own' && JSON.stringify(current.notice) === JSON.stringify(notice)) continue
      await registry.patchInstance(row.id, () => ({ tools: { source: 'own', conflicts: ids, notice, updatedAt: new Date().toISOString() } }))
    }
    for (const { own, take } of moves) {
      writeLibrary(own, take)
      // The row is the commit point. Everything above only added to the library, which the Agent
      // does not read until this write; everything below is tidying that a rerun finishes.
      const moved = Object.keys(take.tools).length + Object.keys(take.services).length + Object.keys(take.keys).length > 0
      // A move that took nothing still says so when it left credentials behind, so that nobody looks for them in the environment.
      await registry.patchInstance(own.row.id, () => ({ tools: { source: 'library', conflicts: [],
        ...(moved || take.kept.length > 0 ? { notice: notices.moved(own, take, { moved }) } : {}), updatedAt: new Date().toISOString() } }))
      outcome.moved.push(own.row)
      // Past the commit an Agent is moved whatever happens next. Tidying that could not finish (a
      // file another program holds open) is left for the next run, which finishes it, and does
      // not stop the Agents after this one from moving. It is also said on the Agent: until it is
      // finished, the old copies it still has can differ from the environment's, and its Worker
      // would then refuse to start with a "differs" that names nothing the person did.
      try { tidy(own, take) } catch (error) {
        outcome.untidy.push({ row: own.row, reason: error.message })
        await noteQuietly(own.row.id, notices.untidy(own, error.message))
      }
    }
    return outcome
  }
  /**
   * Finish what an interrupted or failed tidy left for an Agent that is already on the library:
   * the old files of its own directory, once everything in them is in the environment. `only`
   * limits it to one Agent ("Check again"). It says on the Agent when it still cannot be finished,
   * and takes that note away once nothing is left, so the note never outlives the problem.
   *
   * `skipped` names each Agent that had old files and was left alone, and why: its processes are
   * running (nothing is removed under a running Agent), its old files hold something the
   * environment does not (an unexpected leftover is the Agent's, not ours to drop), or its files
   * cannot be read. "Check again" says it, so that an answer of "already uses the environment's
   * tools" never stands beside a note that says otherwise.
   */
  const finishInterrupted = async (only) => {
    const outcome = { tidied: [], untidy: [], skipped: [] }
    for (const row of registry.read().instances.filter(onLibrary)) {
      if (only !== undefined && row.id !== only) continue
      // Another workbench's processes are not looked at, let alone tidied after.
      if (waiting(row)) { outcome.skipped.push({ row, reason: 'processes of this Agent belong to another Rulith workbench, or were left running.' }); continue }
      let own, take, library
      try { own = readOwn(row); take = movables(own); library = libraryState() } catch (error) {
        outcome.skipped.push({ row, reason: `its files cannot be read: ${sentence(error.message)}` })
        continue
      }
      if (!existsSync(join(own.directory, 'mcp')) && !Object.keys(take.tools).length && !Object.keys(take.keys).length) {
        await settled(row, own)
        continue
      }
      const live = hosts.get(row.id)?.host.status()
      if (live?.worker || live?.agent) {
        outcome.skipped.push({ row, reason: `its ${live.worker ? 'Worker' : 'Agent'} is running, so its files are not touched now. They are removed the next time the workbench starts with it stopped, or check again once it has.` })
        continue
      }
      // Only when everything in it is in the library: an unexpected leftover is the Agent's, not ours to drop.
      const differing = [
        ...Object.values(take.services).filter((service) => !library.services.some((held) => held.name === service.name && serviceIdentity(held) === serviceIdentity(service))).map((service) => service.name),
        ...Object.entries(take.tools).filter(([id, definition]) => !same(library.manifest.tools[id], definition)).map(([id]) => id),
        ...Object.entries(take.keys).filter(([name, source]) => !same(library.keys[name], source)).map(([name]) => name),
      ]
      if (differing.length > 0) {
        outcome.skipped.push({ row, reason: `${differing.join(', ')} in its old files ${differing.length === 1 ? 'differs' : 'differ'} from this environment's.`
          + ' If the environment\'s is the right one, delete that old copy yourself (the originals are also in its tools-before-environment folder), then check again.' })
        continue
      }
      try { tidy(own, take) } catch (error) {
        const notice = notices.untidy(own, error.message)
        outcome.untidy.push({ row, reason: error.message, text: notice.text })
        await noteQuietly(row.id, notice)
        continue
      }
      outcome.tidied.push(row)
      await settled(row, own)
    }
    return outcome
  }
  /** Nothing of a move is left to tidy: an "untidy" note is out of date, and the one worth keeping says where the originals are. */
  const settled = async (row, own) => {
    if (rowOf(row.id)?.tools?.notice?.kind !== 'untidy') return
    await noteQuietly(row.id, existsSync(join(own.directory, BACKUP_DIRECTORY))
      ? notices.moved(own, { keys: {}, services: {} }, { secrets: backupKeepsSecrets(own) }) : undefined)
  }
  let migrating = Promise.resolve()
  const exclusive = (action) => { const run = migrating.then(action, action); migrating = run.then(() => undefined, () => undefined); return run }
  /** Does the library hold anything for a Worker to be given? */
  const hasTools = () => { try { const library = snapshot(); return Object.keys(library.manifest.tools).length + library.services.length > 0 } catch { return false } }
  const waiting = (row) => row.orphaned !== undefined || (row.runtime !== undefined && row.runtime.pid !== process.pid)

  return {
    root, paths,
    /** The page's picture of the library: the tools and services in it, its keys by name, and who uses it. */
    state: () => { preflight(); const view = management.overview(); return { ...view, revision: revisionOf(view), usedBy: usedBy(), libraryRoot: root } },
    hasTools,
    services: () => mcp.overview().services,
    save: async (body) => { const checked = review(body); const result = management.save(checked); markLibrary(); return changed({ ...result,
      teaching: 'Tool definition saved in this environment. After running work finishes, Agents receive the change. Review and lock its contract again in Console.' }) },
    remove: async (body) => { const checked = review(body); return changed({ ...management.remove(checked),
      teaching: 'Tool removed from this environment. Permissions and historical receipts remain in Console.' }) },
    install: (catalogId) => { preflight(); markLibrary(); return mcp.install(catalogId) },
    prepare: (body) => { preflight(); markLibrary(); return mcp.prepareRegistry(body) },
    probe: async (body) => {
      preflight(); const revision = revisionOf(management.overview())
      markLibrary(); const result = await mcp.probe(body)
      probes.clear(); probes.set(result.probeId, revision)
      return result
    },
    apply: async (body) => {
      review(body, probes.get(body.probeId))
      const result = await mcp.apply(body); probes.clear()
      return changed({ ...result, teaching: 'Service saved in this environment. Import the Source definition in Console, then bind and enable its tools for each Agent that needs it.' })
    },
    removeService: async (body) => { review(body); const result = await mcp.remove(body.name); probes.clear(); return changed(result) },
    search: (query, cursor) => mcp.search(query, cursor),
    detail: (name, version) => mcp.detail(name, version),
    downloads: (packageName) => mcp.downloads(packageName),
    /** Reload the Workers a change reaches; `pending` names the Agents whose reload could not be made. Never rejects. */
    reloadAffected,
    /** The sentence that says some Workers have not picked a change up yet; nothing when none is waiting. */
    pendingNote,

    /**
     * What an instance's host is given: the composition for the Agent it serves.
     *
     * Everything here reads the Agent's row afresh, because the row is what says whether the
     * Agent is on the library, and it changes under a running host (a move, a "check again").
     */
    forInstance: (id) => ({
      active: () => onLibrary(rowOf(id)),
      /** Write the two files this Agent's Worker is started with and name them, and the keys' file, in its environment. */
      workerEnvironment: (environment, directory) => {
        const files = lane(need(id))
        const result = composed(id, () => ownFromFiles(environment, directory), environment, { prepare: true })
        // This Worker is composed into these paths from here on: a try to remove what an earlier one left there is over.
        cancelDiscard(id)
        composedAt.set(id, { tools: files.tools, vault: files.vault })
        writeJsonAtomic(files.tools, result.manifest)
        writeJsonAtomic(files.vault, result.vault)
        startedWith.set(id, result.digest)
        return { ...environment, RULITH_TOOLS_FILE: files.tools, RULITH_SECRETS_FILE: files.vault, [ENVIRONMENT_VAULT_VARIABLE]: paths.vault }
      },
      /** What the Worker would start with now, from the Agent's own inputs as `own`; nothing is written. */
      check: (own, environment) => composed(id, () => own, environment).digest,
      hasTools,
      services: () => mcp.overview().services,
      inventory: () => { preflight(); return management.overview() },
      notice: () => rowOf(id)?.tools?.notice?.text ?? '',
      /**
       * The Worker is gone: its composed files hold service credentials and have no further use.
       *
       * Never throws. A file that will not go is retried (`discard`), and each of the two is tried
       * whatever happened to the other, so a failure here cannot keep the caller from recording that
       * the Worker stopped, and cannot leave the vault behind because the tools file was held.
       */
      stopped: () => {
        startedWith.delete(id)
        let files = composedAt.get(id)
        if (files === undefined) {
          // Composed by an earlier run of the workbench: its files are where this Agent's lane puts them.
          try { const row = rowOf(id); if (row === undefined) return; files = lane(row) } catch { return }
        }
        discard(id, files)
      },
    }),

    /**
     * Move every Agent that can into the library, at the start of the workbench.
     *
     * Not done for an Agent whose processes another workbench owns or left behind, since its files
     * may be in use. A failure is recorded as a notice on each Agent that was waiting, and leaves
     * every one of them on the files it has.
     */
    migrateAll: () => exclusive(async () => {
      let rows
      try {
        rows = registry.read().instances.filter((row) => {
          const live = hosts.get(row.id)?.host.status()
          return !onLibrary(row) && !waiting(row) && !live?.worker && !live?.agent
        })
        const finished = await finishInterrupted()
        const outcome = await migrate(rows)
        outcome.untidy.push(...finished.untidy)
        return outcome
      } catch (error) {
        // Only Agents that have not moved: one that already did keeps what it was committed as.
        for (const row of (rows ?? []).filter((entry) => !onLibrary(rowOf(entry.id)))) {
          await registry.patchInstance(row.id, () => ({ tools: { source: 'own', conflicts: [], updatedAt: new Date().toISOString(),
            notice: { kind: 'conflict', text: `Moving ${agentOf(row)}'s tools into this environment did not finish: ${error.message} ${agentOf(row)} keeps its own tools; check again once it is fixed.` } } })).catch(() => undefined)
        }
        return { moved: [], kept: (rows ?? []).map((row) => ({ row, reason: error.message })), error: error.message }
      }
    }),
    /** "Check again": try to move one Agent, now. Refused while that Agent's Worker is running. */
    migrateInstance: (id) => exclusive(async () => {
      const row = rowOf(id)
      if (row === undefined) throw new Error(`No local instance ${id} is registered.`)
      if (waiting(row)) throw new Error(`${agentOf(row)} has processes that another Rulith workbench owns or left running. Stop them first.`)
      if (hosts.get(id)?.host.status().worker) throw new Error(`${agentOf(row)} is using local tools. Turn off "Use this environment's tools and files", then check again.`)
      if (onLibrary(row)) {
        // Already moved: what "Check again" can still do is finish the tidying a failure left, and say whether it did.
        const finished = await finishInterrupted(id)
        // "Already uses this environment's tools" is only said when nothing was left: an Agent with old
        // files that were not removed is told why they were not, beside the note that says they are there.
        const teaching = finished.untidy[0]?.text
          ?? (finished.skipped[0] ? `${agentOf(row)} uses this environment's tools, but its old files were not removed: ${finished.skipped[0].reason}`
            : finished.tidied.length ? `Finished removing ${agentOf(row)}'s old files. It uses this environment's tools.` : `${agentOf(row)} already uses this environment's tools.`)
        return { moved: [], kept: [], untidy: finished.untidy, skipped: finished.skipped, teaching }
      }
      const outcome = await migrate([row])
      const current = rowOf(id).tools
      return { ...outcome, teaching: current?.notice?.text ?? `${agentOf(row)} uses this environment's tools.` }
    }),
    close: () => {
      probes.clear()
      // The last try for files that would not go: the workbench closes its hosts first, so by now no
      // Worker is using them. What still will not go is said, as it is when the tries run out, unless it already was.
      for (const [id, { files, timer, reported }] of unremoved) {
        clearTimeout(timer)
        if (workerRunning(id)) continue
        const failed = removeComposed(files)
        if (failed.length > 0 && !reported) reportUnremoved(failed)
      }
      unremoved.clear()
      return mcp.close()
    },
  }
}

// SPDX-License-Identifier: Apache-2.0
/**
 * The manager's root registry: which local instances exist, and what this installation's
 * account/device authorization currently is.
 *
 * Three rules shape this file, and each one exists because the alternative is a real
 * failure an operator would have to untangle by hand:
 *
 *   · **Stable ids, never display names.** An instance is identified by an opaque id that
 *     is also its directory name. Two instances may legitimately be called "Laptop", and a
 *     registry keyed on what a person typed would merge their credentials, histories and
 *     ports the first time that happened.
 *   · **No secrets here.** This file is read to render a page. The device management token,
 *     the pairing proof and the RSA private key live in a separate 0600 file that no route
 *     returns; what is kept here is status an operator is entitled to see.
 *   · **A lock is only released by proof of death, never by impatience.** Registry edits are
 *     read-modify-write, serialized in-process by a promise chain and across processes by an
 *     exclusively created lock file. A holder that is slow is still a holder.
 *
 * ## Why the lock never expires
 *
 * An earlier version treated a lock older than thirty seconds as abandoned and deleted it.
 * That is a lock in name only: a manager doing a slow first-run install, a network pairing
 * on a bad connection, or a machine that suspended mid-edit outlives that window while very
 * much alive, and the next process would take the lock out from under it and both would
 * read-modify-write the same file. It also treated an *unreadable* lock as proof of death,
 * but an unreadable lock is the normal appearance of one that was created a microsecond ago
 * and has not had its metadata written yet — so the common case of two managers starting
 * together was exactly the case that broke.
 *
 * So: age proves nothing, and absence of evidence proves nothing. A lock is reclaimed only
 * when its recorded owner is a process on **this machine** that the kernel says is gone. An
 * unreadable or foreign-host lock is ambiguous and is waited on, then reported. Ownership is
 * re-verified after acquisition and again before every write and before release, because the
 * one thing worse than waiting for a lock is believing you hold one you do not.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const REGISTRY_FORMAT = 'rulith-local-manager/1'
const LOCK_POLL_MS = 25
/** How long a caller waits for a lock somebody else legitimately holds before reporting. */
const LOCK_WAIT_MS = 15_000
export const INSTANCE_ID_PATTERN = /^inst-[0-9a-f]{12}$/

export function defaultManagerRoot(home = homedir()) { return join(home, '.rulith', 'manager') }

const delay = (ms) => new Promise((done) => { const timer = setTimeout(done, ms); timer.unref?.() })

export function writeJsonAtomic(file, value, mode = 0o600) {
  mkdirSync(dirname(resolve(file)), { recursive: true, mode: 0o700 })
  const temporary = file + '.' + randomUUID() + '.tmp'
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode, flag: 'wx' })
    renameSync(temporary, file)
  } finally { rmSync(temporary, { force: true }) }
}

/**
 * Is the process that wrote a lock or claimed an instance still there?
 *
 * `kill(pid, 0)` sends no signal and only asks the kernel. `EPERM` means the process
 * exists and belongs to somebody else, which is still "alive" — answering `false` there
 * would let one account's manager steal another's instance directory.
 */
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

/** A registry file that exists but cannot be understood. Never repaired, never overwritten. */
export class RegistryUnreadableError extends Error {
  constructor(file, detail) {
    super(`The manager registry at ${file} cannot be read: ${detail}.`
      + ' Nothing was changed. Move or repair the file, then start the manager again —'
      + ' instance directories and their credentials are untouched and can be re-registered.')
    this.name = 'RegistryUnreadableError'
    this.file = file
  }
}

/** The registry is held by somebody else, or by nobody this process can prove is gone. */
export class RegistryLockedError extends Error {
  constructor(message) { super(message); this.name = 'RegistryLockedError' }
}

const lockRecordOf = (raw) => {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  let value
  try { value = JSON.parse(raw) } catch { return undefined }
  if (value === null || typeof value !== 'object' || !Number.isInteger(value.pid) || typeof value.id !== 'string') return undefined
  return value
}

/**
 * What a lock file says, told apart from what could not be asked.
 *
 * Collapsing these was a real defect: a read that failed for a transient reason — an indexer
 * or a virus scanner holding the file open, which on this project's primary platform is an
 * ordinary event — looked identical to "there is no lock". After a process had created its
 * own lock with `wx`, that reading said "somebody took it from me", so it looped, left its own
 * lock behind, and then spent the whole wait window discovering that the lock was held by a
 * living process: itself.
 */
function readLockFile(lockFile) {
  let raw
  try { raw = readFileSync(lockFile, 'utf8') } catch (error) {
    return { state: error?.code === 'ENOENT' ? 'absent' : 'unknown', code: error?.code }
  }
  const record = lockRecordOf(raw)
  return record === undefined ? { state: 'anonymous' } : { state: 'held', record }
}

/**
 * One attempt to take `lockFile`, and what to say if it is somebody else's.
 *
 * Shared by the per-edit registry lock and the workbench lease so both obey exactly the same
 * rules: no expiry, a lock is reclaimed only when its record names a process **on this host**
 * that the kernel says is gone, an unreadable or foreign-host lock is ambiguous and waited on,
 * and ownership is confirmed by reading the ticket back.
 */
function tryTakeLock(lockFile, ticket) {
  try {
    mkdirSync(dirname(lockFile), { recursive: true, mode: 0o700 })
    writeFileSync(lockFile, JSON.stringify(ticket), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const seen = readLockFile(lockFile)
    if (seen.state === 'unknown') return { taken: false, ambiguity: `a lock file that could not be read (${seen.code})` }
    if (seen.state === 'absent') return { taken: false, retry: true }
    const held = seen.record
    if (held === undefined) {
      // A lock created microseconds ago looks exactly like this, and so does one from a
      // process that died between `open` and `write`. Waiting costs milliseconds; deleting
      // costs correctness.
      return { taken: false, ambiguity: 'a lock file whose owner has not been recorded yet' }
    }
    if (held.host !== hostname()) return { taken: false, ambiguity: `a lock held by process ${held.pid} on ${held.host}`, held }
    if (processAlive(held.pid)) return { taken: false, ambiguity: `a lock held by running process ${held.pid}`, held }
    // Proven dead, on this machine. Re-read immediately before removing so a lock that was
    // replaced while this decision was being made is not the one that gets deleted.
    const confirmed = readLockFile(lockFile)
    if (confirmed.state === 'held' && confirmed.record.id === held.id && !processAlive(confirmed.record.pid)) {
      rmSync(lockFile, { force: true })
    }
    return { taken: false, retry: true, held }
  }
  // `wx` is the mutual exclusion, but another process may have been reclaiming a stale lock at
  // the same instant and removed this one. A lock that reads back as somebody else's is not
  // this process's; one that cannot be read at all is still the one it just created.
  const back = readLockFile(lockFile)
  if (back.state === 'held' && back.record.id !== ticket.id) return { taken: false, retry: true }
  return { taken: true }
}

/**
 * Does this process still hold `lockFile` under `ticket`?
 *
 * `unknown` — the file could not be read — answers yes: `wx` creation is the strongest
 * evidence available, and treating an unreadable file as somebody else's is the poisoning
 * above.
 */
const stillOwns = (lockFile, ticket) => {
  const seen = readLockFile(lockFile)
  if (seen.state === 'unknown') return true
  return seen.state === 'held' && seen.record.id === ticket.id
}

/**
 * Hold `lockFile` for the duration of `action`, or refuse.
 *
 * `action` receives an `owned()` predicate. Any step that must not happen without the lock
 * asks it first — the one place this matters is the write inside `update`, where believing a
 * stale claim would mean two processes writing one file.
 */
async function withFileLock(lockFile, action, { waitMs = LOCK_WAIT_MS } = {}) {
  const ticket = { pid: process.pid, host: hostname(), id: randomUUID(), at: Date.now() }
  const owned = () => stillOwns(lockFile, ticket)
  const deadline = Date.now() + waitMs
  let lastAmbiguity = ''
  while (Date.now() <= deadline) {
    const attempt = tryTakeLock(lockFile, ticket)
    if (!attempt.taken) {
      if (attempt.ambiguity !== undefined) lastAmbiguity = attempt.ambiguity
      if (attempt.retry !== true) await delay(LOCK_POLL_MS)
      continue
    }
    try {
      return await action({ owned })
    } finally {
      // Release only what is still ours. Unlinking somebody else's lock because this call is
      // finishing is the same defect as stealing one because it looked old.
      if (owned()) rmSync(lockFile, { force: true })
    }
  }
  throw new RegistryLockedError(`The manager registry is locked: ${lastAmbiguity || 'another process holds it'}.`
    + ' Nothing was changed. Close the other Rulith manager, or wait for it to finish, and retry.')
}

/** A second workbench process is already running against this installation. */
export class WorkbenchBusyError extends Error {
  constructor(message) { super(message); this.name = 'WorkbenchBusyError' }
}

/**
 * Claim this installation for the lifetime of one workbench process.
 *
 * Per-edit locking cannot express this. Opening an instance is read `runtime`, create a host,
 * listen, then record the pid — several awaits long — and the registry lock only serializes
 * the *writes* inside it. Two managers on one root therefore both saw no owner, both listened,
 * and each wrote its own pid over the other's; they also shared one `device.json`, where
 * interleaved read-modify-write would lose account state that no per-file queue in either
 * process can see.
 *
 * So the simple thing: one workbench per manager root, held for the run. It is a different
 * file from the registry's per-edit lock, because their lifetimes are different — this one is
 * held while nothing at all is happening, which a lock that guards a single edit must never be.
 *
 * Taken when the server starts listening, not in the constructor: a library caller that builds
 * a manager to inspect it, and the several this repository's tests build in one process, must
 * not each claim the installation.
 */
export async function acquireWorkbenchLease(lockFile, { waitMs = 0 } = {}) {
  const ticket = { pid: process.pid, host: hostname(), id: randomUUID(), at: Date.now(), purpose: 'workbench' }
  const deadline = Date.now() + waitMs
  let lastAmbiguity = ''
  let holder
  // `retry` means the file changed under this attempt — usually because a provably dead
  // owner's claim was just removed. That is not waiting for anybody, so it is retried at once
  // even with no wait budget: a workbench starting after a crashed one would otherwise clean
  // up the stale claim and then refuse to take it. Bounded, so a pathological file cannot spin.
  let immediate = 8
  for (;;) {
    const attempt = tryTakeLock(lockFile, ticket)
    if (attempt.taken) {
      return {
        file: lockFile,
        pid: process.pid,
        owned: () => stillOwns(lockFile, ticket),
        release: () => { if (stillOwns(lockFile, ticket)) rmSync(lockFile, { force: true }) },
      }
    }
    if (attempt.ambiguity !== undefined) lastAmbiguity = attempt.ambiguity
    if (attempt.held !== undefined) holder = attempt.held
    if (attempt.retry === true && immediate > 0) { immediate -= 1; continue }
    if (Date.now() >= deadline) break
    // A *referenced* timer, unlike the registry's. This runs at startup, when nothing else is
    // pending: an unref'd wait lets the event loop drain and the process reports an unsettled
    // top-level await instead of the refusal it was about to produce.
    await new Promise((done) => setTimeout(done, LOCK_POLL_MS))
  }
  throw new WorkbenchBusyError(
    `Another Rulith workbench is already running on this installation (${lastAmbiguity || 'lock held'}`
    + `${holder?.host !== undefined && holder.host !== hostname() ? '' : ''}).`
    + ` Close it, or point this one at a different installation with RULITH_MANAGER_HOME.`
    + ' Two workbenches on one installation would each open their own web host for the same Agents'
    + ' and write over each other\'s account state.')
}

export function emptyRegistry() {
  return { format: REGISTRY_FORMAT, instances: [], device: { state: 'none' } }
}

/**
 * Read the registry as it is, or say why it cannot be read.
 *
 * An earlier version answered every defect with an empty or partially filtered registry.
 * That turns one unreadable byte into "this computer has no instances", and the next write
 * makes it true: the profiles, their ports and their recorded account bindings are gone, and
 * the only sign anything happened is that a list looks shorter than the operator remembers.
 *
 * So a file that exists and is not a valid registry is an error with the path in it. Nothing
 * is dropped, nothing is repaired, and nothing is written over it. A record that cannot be
 * addressed — no id, a malformed id, a duplicate id, a duplicate directory, no directory —
 * is part of that: silently discarding it is how a profile disappears, and silently keeping
 * two rows with one id is how an operation lands on the wrong one.
 */
export function validateRegistry(value, file = 'the manager registry') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new RegistryUnreadableError(file, 'the top level is not a JSON object')
  if (value.format !== undefined && value.format !== REGISTRY_FORMAT) {
    throw new RegistryUnreadableError(file, `format ${JSON.stringify(value.format)} is not ${REGISTRY_FORMAT}`)
  }
  if (value.instances !== undefined && !Array.isArray(value.instances)) throw new RegistryUnreadableError(file, '"instances" is not an array')
  const ids = new Set()
  const directories = new Map()
  const instances = (value.instances ?? []).map((row, index) => {
    const at = `instances[${index}]`
    if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new RegistryUnreadableError(file, `${at} is not an object`)
    const id = typeof row.id === 'string' ? row.id : ''
    if (!INSTANCE_ID_PATTERN.test(id)) throw new RegistryUnreadableError(file, `${at} has no usable instance id (${JSON.stringify(row.id)})`)
    if (ids.has(id)) throw new RegistryUnreadableError(file, `${at} repeats instance id ${id}`)
    ids.add(id)
    const directory = typeof row.directory === 'string' ? row.directory.trim() : ''
    if (directory === '') throw new RegistryUnreadableError(file, `${at} (${id}) has no directory`)
    const key = resolve(directory).toLowerCase()
    if (directories.has(key)) throw new RegistryUnreadableError(file, `${at} (${id}) shares a directory with ${directories.get(key)}`)
    directories.set(key, id)
    if (row.mode !== undefined && row.mode !== 'local_agent' && row.mode !== 'existing_client') {
      throw new RegistryUnreadableError(file, `${at} (${id}) has mode ${JSON.stringify(row.mode)}`)
    }
    return { ...row, id, directory, name: typeof row.name === 'string' && row.name !== '' ? row.name : id,
      mode: row.mode ?? 'local_agent' }
  })
  const device = value.device
  if (device !== undefined && (device === null || typeof device !== 'object' || Array.isArray(device))) {
    throw new RegistryUnreadableError(file, '"device" is not an object')
  }
  return { ...value, format: REGISTRY_FORMAT, instances, device: device ?? { state: 'none' } }
}

export function newInstanceId() { return 'inst-' + randomUUID().replace(/-/g, '').slice(0, 12) }

export function createManagerRegistry({ root = defaultManagerRoot(), lockWaitMs } = {}) {
  const home = resolve(root)
  const file = join(home, 'registry.json')
  const lockFile = join(home, 'registry.lock')
  // In-process serialization. The file lock protects against another manager process; this
  // chain protects against this process's own concurrent requests, which would otherwise
  // each take the lock, read the same state, and write back the last one's view.
  let queue = Promise.resolve()

  const read = () => {
    if (!existsSync(file)) return emptyRegistry()
    let raw
    try { raw = readFileSync(file, 'utf8') } catch (error) { throw new RegistryUnreadableError(file, String(error?.code ?? error?.message ?? error)) }
    let parsed
    try { parsed = JSON.parse(raw) } catch (error) { throw new RegistryUnreadableError(file, `invalid JSON (${error.message})`) }
    return validateRegistry(parsed, file)
  }
  const update = (mutate) => {
    const run = queue.then(() => withFileLock(lockFile, async ({ owned }) => {
      const current = read()
      const next = validateRegistry(await mutate(structuredClone(current), current), file)
      // The write is the only irreversible step, so it asks one last time whether this
      // process still holds the lock it was granted.
      if (!owned()) throw new RegistryLockedError('This manager lost the registry lock before its edit was written. Nothing was changed; retry.')
      writeJsonAtomic(file, next)
      return next
    }, lockWaitMs === undefined ? {} : { waitMs: lockWaitMs }))
    // Keep the chain alive after a rejection: one failed edit must not wedge every later one.
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  return {
    root: home,
    file,
    lockFile,
    read,
    update,
    instances: () => read().instances,
    instance: (id) => read().instances.find((row) => row.id === id),
    /**
     * Forget the ownership markers of managers that are provably gone — and only those.
     *
     * A manager writes `runtime: {pid, children}` when it opens an instance's host, so a
     * second manager can refuse to open the same directory twice. A killed manager leaves
     * that marker behind, and clearing it is what makes a crash recoverable.
     *
     * **A dead manager does not imply dead children.** The Agent and Worker are separate
     * processes; killing their parent does not kill them, and an instance whose Agent is
     * still running is still holding its credential and its Board connection. So a marker is
     * only cleared when the manager is gone *and* every child it recorded is gone too.
     * Anything else is recorded as orphaned, with the pids, and refused rather than reopened.
     */
    reclaimStale: () => update((state) => {
      for (const row of state.instances) {
        if (row.runtime === undefined) continue
        if (processAlive(row.runtime.pid)) continue
        const living = (row.runtime.children ?? []).filter((child) => processAlive(child.pid))
        if (living.length === 0) { delete row.runtime; delete row.orphaned; continue }
        row.orphaned = { managerPid: row.runtime.pid, children: living, observedAt: new Date().toISOString() }
      }
      return state
    }),
    patchInstance: (id, mutate) => update((state) => {
      const row = state.instances.find((entry) => entry.id === id)
      if (row === undefined) throw new Error(`No local instance ${id} is registered.`)
      Object.assign(row, mutate(row) ?? {})
      return state
    }),
  }
}

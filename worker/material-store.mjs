// SPDX-License-Identifier: Apache-2.0
/**
 * The material area: immutable local bytes, owned by one runtime profile, that never leave it.
 *
 * Two kinds of object live here and they are the same thing on disk: **material** a person
 * added (`mat_…`), and **result** bytes an action produced (`res_…`). Both are content-addressed,
 * chunked at a fixed 64 KiB, and written whole or not at all. Gateway holds a reference, a
 * manifest and a permission; this holds the only copy of the bytes.
 *
 * Three properties decide everything below, and each one is a refusal rather than a convention:
 *
 *   · **Immutable.** An object is written into a private temporary directory, fsynced, and
 *     renamed into place as a whole. A reader observes an object or no object, never half of
 *     one, and an object never changes after it lands.
 *   · **Owned.** The area is bound to a profile and to a *stable* identity — the Gateway origin,
 *     the Connection, and the Agent this host knows itself to be. Deliberately **not** to a
 *     secret: rotating a key is the same identity and must not erase somebody's files, while
 *     pointing the profile at another Gateway or another Connection is a different owner and
 *     fails closed. An area with no identity at all is refused outright rather than bucketed
 *     under a hash of the empty string, which would make every unconfigured profile on a machine
 *     look like the same owner.
 *   · **Bounded in where it may be disclosed.** Each record also records the model destination
 *     configured when the bytes were added. That is the host's own gate on "the operator edited
 *     the model URL after selecting an attachment"; it is **not** authorization. Authorization
 *     for any disclosure is the Gateway's, obtained per read — see `POST /work/artifact/claim`
 *     in the material wire. Nothing in this file mints or validates a capability.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * The on-disk format this build implements.
 *
 * A store marked with any other version is refused with `materials_store_migration_required`.
 * It is deliberately not reinterpreted: an index whose meaning has changed reads as data that
 * happens to parse, and the failure mode of guessing is a file served under somebody else's
 * owner binding.
 */
export const MATERIAL_STORE_VERSION = 'rulith-materials/3'
/** The deployment constant the material wire fixes. A per-object chunk size does not exist. */
export const MATERIAL_CHUNK_BYTES = 65_536
/** The documented per-file ceiling for something a person adds, in original bytes. */
export const MAX_MATERIAL_BYTES = 8 * 1024 * 1024
/** The wire's `maximumObjectBytes`: what an action result may grow to before it is refused. */
export const MAX_OBJECT_BYTES = 32 * 1024 * 1024
/** Smallest HTTP body ceiling that admits 8 MiB of canonical base64 plus the JSON envelope. */
export const MAX_MATERIAL_REQUEST_BYTES = 12 * 1024 * 1024
/** How many materials one case submission may carry. */
export const MAX_ATTACHMENTS = 8
export const MATERIAL_ID_PATTERN = /^mat_[0-9a-f]{32}$/
export const MATERIAL_UI_HANDLE_PATTERN = /^ui_[0-9a-f]{32}$/
export const RESULT_ID_PATTERN = /^res_[0-9a-f]{32}$/
export const MATERIAL_OBJECT_ID_PATTERN = /^(?:mat|res)_[0-9a-f]{32}$/
export const MATERIAL_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
/** The custody acknowledgement string the wire requires a registration to carry. */
export const MATERIAL_CUSTODY_ACKNOWLEDGEMENT = 'rulith-worker-custody/1'

/** A refusal with a stable code, so a caller can tell the cases apart without reading prose. */
export class MaterialError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'MaterialError'
    this.code = code
  }
}

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const fingerprint = (...parts) => createHash('sha256').update(parts.join('\u0000')).digest('hex')
export const materialAgentFingerprint = (agentId) => fingerprint('rulith-material-agent', String(agentId ?? ''))

/**
 * Windows device names are not ordinary file names even when they are used as display text.
 * They are refused here because the display name is shown beside a path-shaped affordance, and
 * a name that reads as a device is the first half of somebody later making it one.
 */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u

/**
 * The display name, checked as a display name.
 *
 * It is never joined onto a path — storage is keyed by a host-generated opaque id — so this is
 * not a traversal fence standing alone. It is refused anyway, by name, because a value that is
 * safe only because of where it currently happens to be used is a value that stops being safe
 * the first time somebody uses it somewhere else.
 */
export function materialDisplayName(raw) {
  if (typeof raw !== 'string' || raw === '') {
    throw new MaterialError('material_name_invalid', 'A material needs a non-empty display name.')
  }
  if ([...raw].length > 255) {
    throw new MaterialError('material_name_invalid', 'A material display name is at most 255 characters.')
  }
  if (CONTROL_CHARACTERS.test(raw)) {
    throw new MaterialError('material_name_control',
      'A material display name may not contain NUL or other control characters.')
  }
  if (raw.includes('/') || raw.includes('\\')) {
    throw new MaterialError('material_name_path',
      'A material display name may not contain a path separator. The stored location is chosen by this host, never by the name.')
  }
  if (/^[A-Za-z]:/.test(raw)) {
    throw new MaterialError('material_name_path', 'A material display name may not begin with a drive letter.')
  }
  if (raw === '.' || raw === '..' || raw.includes('..')) {
    throw new MaterialError('material_name_traversal', 'A material display name may not contain a relative path segment.')
  }
  if (raw !== raw.trim() || raw.endsWith('.')) {
    throw new MaterialError('material_name_invalid',
      'A material display name may not begin or end with whitespace, or end with a dot.')
  }
  if (WINDOWS_DEVICE.test(raw)) {
    throw new MaterialError('material_name_reserved', 'A material display name may not be a reserved device name.')
  }
  return raw
}

/** A media type is a label the model may be shown; it is not allowed to be a payload. */
export function materialMediaType(raw) {
  const value = String(raw ?? '').trim() || 'application/octet-stream'
  if (value.length > 200 || CONTROL_CHARACTERS.test(value)
    || !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*(\s*;\s*[a-z0-9-]+=[^\s;]+)*$/i.test(value)) {
    throw new MaterialError('material_media_type_invalid', `${JSON.stringify(String(raw ?? ''))} is not a media type.`)
  }
  return value
}

/**
 * Canonical base64 only.
 *
 * `Buffer.from(x, 'base64')` is famously forgiving: it skips whitespace, tolerates junk, and
 * ignores trailing bits that no encoder would ever produce. Two different texts therefore decode
 * to the same bytes, which means the digest the caller was told about is not a function of what
 * the caller sent. Re-encoding and demanding equality is the whole check.
 */
export function decodeCanonicalBase64(raw) {
  if (typeof raw !== 'string') {
    throw new MaterialError('material_bytes_invalid', 'bytes must be a base64 string.')
  }
  if (raw === '' || raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    throw new MaterialError('material_bytes_invalid', 'bytes must be canonical base64 with standard padding.')
  }
  const bytes = Buffer.from(raw, 'base64')
  if (bytes.byteLength === 0 || bytes.toString('base64') !== raw) {
    throw new MaterialError('material_bytes_not_canonical',
      'bytes is not canonical base64: re-encoding the decoded value does not reproduce it.')
  }
  return bytes
}

/**
 * The model endpoint, reduced to the thing that decides where bytes would go.
 *
 * Credentials, query and fragment are removed because they are not destinations, and a trailing
 * slash is removed because two spellings of one endpoint must not read as two policies.
 */
export function normalizeModelDestination(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return ''
  try {
    const url = new URL(text)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`.toLowerCase()
  } catch {
    return text.toLowerCase()
  }
}

/** Does this destination keep the bytes on this machine? */
export function isLoopbackDestination(destination) {
  return /^https?:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?(\/|$)/.test(String(destination ?? ''))
}

/**
 * Who owns this material area, stated as things that do not change when a key is rotated.
 *
 * The three parts are the Gateway this profile talks to, the Connection it holds, and the Agent
 * it is. A secret is deliberately not among them: rotating `RULITH_TOKEN` or a Connection key is
 * the same owner continuing, and a binding that moved would silently make somebody's files
 * unreadable at exactly the moment they did the safe thing. Re-pointing the profile at another
 * Gateway, or at another Connection, is a different owner and fails closed.
 *
 * An area with **no** identity is refused rather than given the hash of the empty string. That
 * fallback would make every unconfigured profile on a machine look like one owner, which is the
 * opposite of what an owner binding is for.
 */
export function materialIdentity({ configFile, gatewayUrl = '', connectionId = '', agentId = '', modelUrl = '', model = '' } = {}) {
  const gateway = normalizeModelDestination(gatewayUrl)
  const connection = String(connectionId ?? '').trim()
  const agent = String(agentId ?? '').trim() === 'unconfigured' ? '' : String(agentId ?? '').trim()
  if (connection === '' && agent === '') {
    throw new MaterialError('materials_owner_unidentified',
      'This profile has no Connection and no Agent identity, so a material area would have no owner to bind to.'
      + ' Configure the Worker Connection or complete Agent pairing before adding local material.')
  }
  const modelDestination = normalizeModelDestination(modelUrl)
  return {
    profile: fingerprint('rulith-material-profile', resolve(String(configFile ?? ''))),
    // The Gateway and the Connection are known from configuration alone, so they are the
    // fingerprint every process can compute — including the Worker, which never learns the
    // Agent identity. The Agent is bound separately, below: a host learns it from its running
    // Agent, which means it is *not yet known* at the moment the area is first created, and an
    // owner that changed the instant the Agent reported would lock the profile out of its own
    // files for no reason anybody could see.
    owner: fingerprint('rulith-material-owner', gateway, connection),
    gateway,
    connection,
    agentId: agent,
    agentFingerprint: agent ? materialAgentFingerprint(agent) : '',
    modelDestination,
    model: String(model ?? ''),
    localOnly: isLoopbackDestination(modelDestination),
  }
}

/**
 * The same identity, for a process that must not hold the Agent credential.
 *
 * The Worker is one of those processes, deliberately. The host that does hold the credentials
 * passes the two *fingerprints* it computed; the Worker binds against those and never
 * reconstructs anything from them. A missing or malformed fingerprint is refused rather than
 * defaulted: an identity that fell back to a constant would make every profile's materials look
 * like every other profile's.
 */
export function materialIdentityFromFingerprints({ profile, owner, agentFingerprint = '', modelDestination = '', model = '' } = {}) {
  for (const [name, value] of [['profile', profile], ['owner', owner]]) {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
      throw new MaterialError('material_identity_invalid',
        `The material ${name} fingerprint must be a 64-character lowercase sha256. This process was given`
        + ` ${JSON.stringify(String(value ?? ''))}, and an identity is not guessed at.`)
    }
  }
  if (agentFingerprint !== '' && !/^[0-9a-f]{64}$/.test(agentFingerprint)) {
    throw new MaterialError('material_identity_invalid', 'The Agent fingerprint must be lowercase sha256.')
  }
  const destination = normalizeModelDestination(modelDestination)
  return {
    profile, owner,
    // Deliberately empty. A process holding only fingerprints is one that was never told which
    // Agent this profile is — the Worker is exactly that — and an empty Agent opens an area
    // under its recorded one rather than claiming to be it.
    agentId: '', agentFingerprint,
    modelDestination: destination, model: String(model ?? ''),
    localOnly: isLoopbackDestination(destination),
  }
}

/** The store directory for one profile. It is a sibling of the configuration file, never inside it. */
export function defaultMaterialRoot(configFile) {
  return join(dirname(resolve(String(configFile ?? ''))), 'materials')
}

function assertRealDirectory(path, what) {
  const info = lstatSync(path)
  if (info.isSymbolicLink()) {
    throw new MaterialError('materials_store_reparse',
      `${what} is a symbolic link or reparse point. The material area must be a real directory inside the profile.`)
  }
  if (!info.isDirectory()) {
    throw new MaterialError('materials_store_not_directory', `${what} is not a directory.`)
  }
  // A junction one level up redirects everything below it, and `lstat` on the leaf says nothing
  // about that. Comparing the resolved path with the literal one catches the whole chain.
  const actual = realpathSync(path)
  if (resolve(actual) !== resolve(path)) {
    throw new MaterialError('materials_store_reparse',
      `${what} resolves to ${actual}, outside the path this profile configured. The material area must not be redirected.`)
  }
}

function fsyncPath(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    fsyncSync(fd)
  } catch {
    // Directory fsync is not available on every platform; the rename below is still the atomic
    // step, and a host that cannot flush is not a host that may silently skip the rename.
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch { /* nothing further to do */ }
  }
}

function writeFileDurably(path, data) {
  writeFileSync(path, data, { mode: 0o600, flag: 'wx' })
  fsyncPath(path)
}

const submissionLockWait = new Int32Array(new SharedArrayBuffer(4))

/** Serialize one material's submission ledger across Host processes. A stranded lock refuses writes. */
function withSubmissionLock(directory, work) {
  const lock = join(directory, 'submission.lock')
  const deadline = Date.now() + 10_000
  while (true) {
    try {
      mkdirSync(lock, { mode: 0o700 })
      break
    } catch (error) {
      // Windows may report EPERM while another process is removing the lock directory.
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error
      if (Date.now() >= deadline) {
        throw new MaterialError('material_submission_busy', 'The material submission ledger is locked; no context was recorded.')
      }
      Atomics.wait(submissionLockWait, 0, 0, 10)
    }
  }
  try { return work() }
  finally { rmdirSync(lock) }
}

/** The chunk manifest of one object: fixed size, ascending order, last chunk short. */
export function chunkManifest(bytes) {
  const chunks = []
  for (let at = 0; at < bytes.byteLength; at += MATERIAL_CHUNK_BYTES) {
    chunks.push(bytes.subarray(at, Math.min(at + MATERIAL_CHUNK_BYTES, bytes.byteLength)))
  }
  return chunks
}

/**
 * Open (or create) the material area for one profile.
 *
 * Opening is itself a check: a store marked with another format version, bound to another
 * profile, or bound to another owner is refused here rather than at the first read.
 */
export function openMaterialStore(root, identity, { create = true } = {}) {
  const base = resolve(String(root ?? ''))
  if (base === '' || base === resolve('/')) {
    throw new MaterialError('materials_root_invalid', 'A material area needs a configured directory.')
  }
  if (!existsSync(base)) {
    if (!create) throw new MaterialError('materials_store_absent', `No material area at ${base}.`)
    mkdirSync(base, { recursive: true, mode: 0o700 })
  }
  assertRealDirectory(base, 'The material area')
  const markerFile = join(base, 'store.json')
  let marker
  if (existsSync(markerFile)) {
    try {
      marker = JSON.parse(readFileSync(markerFile, 'utf8'))
    } catch {
      throw new MaterialError('materials_store_unreadable',
        `${markerFile} could not be read as JSON. The material area is not interpreted on a guess; move it aside to start a new one.`)
    }
    if (marker?.version !== MATERIAL_STORE_VERSION) {
      throw new MaterialError('materials_store_migration_required',
        `The material area at ${base} is marked ${JSON.stringify(String(marker?.version ?? ''))} and this build implements`
        + ` ${MATERIAL_STORE_VERSION}. It is refused rather than reinterpreted: an index whose meaning has changed would`
        + ' otherwise be read under the wrong owner binding. Migrate it, or point this profile at a new material area.')
    }
    if (marker.profile !== identity.profile) {
      throw new MaterialError('materials_store_profile_mismatch',
        `The material area at ${base} belongs to a different runtime profile. A material area is never shared between profiles.`)
    }
    if (marker.owner !== identity.owner) {
      throw new MaterialError('materials_store_owner_mismatch',
        `The material area at ${base} is bound to a different Gateway or Connection than this profile now names.`
        + ' Rotating a credential keeps the same owner; changing which Gateway or Connection this profile *is* does'
        + ' not, and the existing material is not re-attributed to the new one.')
    }
    // The Agent is bound on first sighting, because a host only learns it from its running
    // Agent. An area created before the Agent reported records an empty one and adopts the
    // first identity it is told; a *different* one afterwards is a different Agent and fails
    // closed. The empty case is never a match for a named one, so an Agent that has not
    // reported yet cannot open an area another Agent owns by not saying who it is.
    const bound = typeof marker.agent === 'string' ? marker.agent : ''
    if (bound !== '' && identity.agentId !== '' && bound !== identity.agentId) {
      throw new MaterialError('materials_store_owner_mismatch',
        `The material area at ${base} belongs to Agent ${JSON.stringify(bound)} and this profile now runs`
        + ` ${JSON.stringify(identity.agentId)}. Material is not re-attributed to whoever is configured next.`)
    }
    if (bound === '' && identity.agentId !== '' && create) {
      marker = { ...marker, agent: identity.agentId }
      writeFileSync(markerFile, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 })
    }
  } else {
    if (!create) throw new MaterialError('materials_store_absent', `No material area at ${base}.`)
    marker = {
      version: MATERIAL_STORE_VERSION, profile: identity.profile, owner: identity.owner,
      agent: identity.agentId, createdAt: new Date().toISOString(),
    }
    writeFileSync(markerFile, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 })
  }
  const objectsDir = join(base, 'objects')
  const tempDir = join(base, 'tmp')
  for (const dir of [objectsDir, tempDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    assertRealDirectory(dir, 'The material storage directory')
  }

  const objectDir = (id) => {
    if (!MATERIAL_OBJECT_ID_PATTERN.test(String(id ?? ''))) {
      throw new MaterialError('material_id_invalid',
        'A material id is an opaque token this host generated. It is not a path and it is not a credential.')
    }
    return join(objectsDir, id)
  }

  const readRecord = (id) => {
    const file = join(objectDir(id), 'record.json')
    if (!existsSync(file)) return undefined
    let record
    try {
      record = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      throw new MaterialError('material_record_corrupt', `The record for ${id} could not be read as JSON.`)
    }
    if (record?.version !== MATERIAL_STORE_VERSION || record.id !== id) {
      throw new MaterialError('material_record_corrupt',
        `The record stored for ${id} does not describe ${id} in this format. It is refused rather than reinterpreted.`)
    }
    return record
  }

  /** Owner-checked lookup. "Not yours" and "not here" answer the same way, deliberately. */
  const ownedRecord = (id) => {
    const record = readRecord(id)
    if (record === undefined) return undefined
    if (record.owner?.profile !== identity.profile || record.owner?.owner !== identity.owner) return undefined
    return record
  }

  const chunkFile = (record, index) =>
    join(objectDir(record.chunksFrom ?? record.id), 'chunks', `${String(index).padStart(6, '0')}.bin`)

  /**
   * One chunk, proved against its pinned digest before it is handed anywhere.
   *
   * "The bytes are not available" and "the bytes are not the bytes" answer under their own names:
   * a person debugging a refused read needs to know whether their file has gone or been edited.
   */
  const chunkOf = (record, index) => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= record.chunks.length) {
      throw new MaterialError('material_chunk_range_invalid',
        `Chunk ${index} is outside the ${record.chunks.length}-chunk manifest of ${record.id}.`)
    }
    const file = chunkFile(record, index)
    if (!existsSync(file)) {
      throw new MaterialError('material_bytes_unavailable',
        `Chunk ${index} of ${record.id} is not on this machine. The material is not readable, and no substitute is produced.`)
    }
    const chunk = readFileSync(file)
    if (sha256(chunk) !== record.chunks[index]) {
      throw new MaterialError('material_chunk_corrupt',
        `Chunk ${index} of ${record.id} does not match its recorded digest. The stored bytes changed after they were written.`)
    }
    return chunk
  }

  const readBytes = (record) => {
    const parts = []
    for (let index = 0; index < record.chunks.length; index++) parts.push(chunkOf(record, index))
    const bytes = Buffer.concat(parts)
    if (bytes.byteLength !== record.totalBytes || sha256(bytes) !== record.digest) {
      throw new MaterialError('material_digest_mismatch',
        `The stored bytes of ${record.id} do not match its recorded length and digest.`)
    }
    return bytes
  }

  const landObject = (id, record, chunks) => {
    const staging = join(tempDir, `${id}.${randomUUID()}`)
    mkdirSync(join(staging, 'chunks'), { recursive: true, mode: 0o700 })
    try {
      for (const [index, chunk] of chunks.entries()) {
        writeFileDurably(join(staging, 'chunks', `${String(index).padStart(6, '0')}.bin`), chunk)
      }
      writeFileDurably(join(staging, 'record.json'), `${JSON.stringify(record, null, 2)}\n`)
      fsyncPath(staging)
      // The whole object appears in one step. Until this returns there is nothing under
      // `objects/` for any reader to find, which is what makes a half-written write invisible
      // rather than partially readable.
      renameSync(staging, objectDir(id))
    } catch (error) {
      rmSync(staging, { recursive: true, force: true })
      throw error
    }
    return record
  }

  /**
   * Whose decision the disclosure binding records — and why the difference matters.
   *
   * `operator` is a file a person added. The model destination configured at that moment was
   * their choice about where this file's contents may go, and nothing later re-decides it: not
   * an edited model URL, and not a Source that is granted off-machine disclosure afterwards.
   *
   * `execution` is bytes an action produced. The profile's model endpoint at production time is
   * not a statement about those bytes at all — treating it as one would stop every deployment
   * that runs a local model from ever having an artifact proxied, which is what the Source's own
   * `proxy` permission exists to decide.
   *
   * A result derived from a material inherits `operator`, because it is that person's file.
   */
  const store = (kind, { name, mediaType, encoding = 'base64', bytes, ceiling, origin }) => {
    const displayName = materialDisplayName(name)
    const type = materialMediaType(mediaType)
    if (!Buffer.isBuffer(bytes)) throw new MaterialError('material_bytes_invalid', 'Material bytes must be a Buffer.')
    if (bytes.byteLength === 0) throw new MaterialError('material_empty', 'An empty object has no content to read.')
    if (bytes.byteLength > ceiling) {
      throw new MaterialError(kind === 'material' ? 'material_too_large' : 'artifact_too_large',
        `This object is ${bytes.byteLength} bytes and the limit is ${ceiling}.`)
    }
    if (encoding !== 'utf8' && encoding !== 'base64') {
      throw new MaterialError('material_encoding_invalid', 'A stored object declares utf8 or base64 encoding.')
    }
    const chunks = chunkManifest(bytes)
    const id = `${kind === 'material' ? 'mat' : 'res'}_${randomUUID().replace(/-/g, '')}`
    const now = new Date().toISOString()
    return landObject(id, {
      version: MATERIAL_STORE_VERSION,
      id,
      ...(kind === 'material' ? {
        selector: `mat_${randomUUID().replace(/-/g, '')}`,
        uiHandle: `ui_${randomUUID().replace(/-/g, '')}`,
        agent: identity.agentId,
      } : {}),
      kind,
      name: displayName,
      mediaType: type,
      encoding,
      totalBytes: bytes.byteLength,
      digest: sha256(bytes),
      chunkBytes: MATERIAL_CHUNK_BYTES,
      chunks: chunks.map((chunk) => sha256(chunk)),
      owner: { profile: identity.profile, owner: identity.owner },
      disclosure: { modelDestination: identity.modelDestination, localOnly: identity.localOnly, origin },
      addedAt: now,
      retention: { policy: 'profile-lifetime', immutable: true, recordedAt: now },
    }, chunks)
  }

  return {
    root: base,
    identity,
    /**
     * The Agent identity this area is bound to, or `''` if none has ever been confirmed.
     *
     * Read by the host that holds both sides of the question — it knows which Agent is running,
     * and this says which one the files belong to — so that the two can be compared before any
     * byte is disclosed. The Worker never has an Agent identity and never consults this.
     */
    boundAgentId: typeof marker.agent === 'string' ? marker.agent : '',
    /** Store one file a person added, whole, before the caller is told it succeeded. */
    put({ name, mediaType, bytes }) {
      return store('material', { name, mediaType, bytes, ceiling: MAX_MATERIAL_BYTES, encoding: 'base64', origin: 'operator' })
    },
    /** The browser receives a local selection handle, never the custody id or model selector. */
    publicMaterial(record) {
      if (!MATERIAL_UI_HANDLE_PATTERN.test(record?.uiHandle ?? '')) {
        throw new MaterialError('material_selection_unavailable', 'This material has no separate local selection handle.')
      }
      return { id: record.uiHandle, name: record.name, mediaType: record.mediaType,
        totalBytes: record.totalBytes, digest: record.digest }
    },
    publicList() {
      return this.list().map((row) => this.publicMaterial(this.require(row.id)))
    },
    /** Resolve only a handle issued for this store and the Agent currently bound to it. */
    selected(handle) {
      if (!MATERIAL_UI_HANDLE_PATTERN.test(String(handle ?? ''))) {
        throw new MaterialError('material_id_invalid', 'The attachment must be a local selection handle issued by this host.')
      }
      for (const row of this.list()) {
        const record = this.require(row.id)
        if (record.uiHandle !== handle) continue
        if (!identity.agentId || (record.agent && record.agent !== identity.agentId) || marker.agent !== identity.agentId) {
          throw new MaterialError('materials_store_owner_mismatch', 'The selection belongs to another Agent.')
        }
        return record
      }
      throw new MaterialError('material_not_found', 'The selected material does not belong to this runtime profile.')
    },
    /** User submission freezes the private selector-to-custody/version mapping durably. */
    submitSelected(handle, context = {}) {
      const record = this.selected(handle)
      const path = join(objectDir(record.id), 'submission.json')
      const binding = { selector: record.selector, custodyId: record.id, digest: record.digest,
        totalBytes: record.totalBytes, owner: record.owner, agent: identity.agentId }
      const submission = { sessionKey: String(context.sessionKey ?? ''), caseId: String(context.caseId ?? ''),
        requestId: String(context.requestId ?? '') }
      if (!submission.sessionKey) throw new MaterialError('material_submission_invalid', 'A material submission needs its conversation identity.')
      if (!MATERIAL_ID_PATTERN.test(record.selector ?? '') || record.selector === record.id) {
        throw new MaterialError('material_selection_unavailable', 'This material has no separate immutable selector.')
      }
      withSubmissionLock(objectDir(record.id), () => {
        if (existsSync(path)) {
          let previous
          try { previous = JSON.parse(readFileSync(path, 'utf8')) } catch { /* mismatch below */ }
          if (Object.keys(binding).some((key) => JSON.stringify(previous?.[key]) !== JSON.stringify(binding[key]))) {
            throw new MaterialError('material_submission_mismatch', 'The submitted material mapping changed.')
          }
          if (!Array.isArray(previous.submissions) || previous.submissions.length === 0
            || previous.submissions.some((row) => typeof row?.sessionKey !== 'string' || row.sessionKey === '')) {
            throw new MaterialError('material_submission_mismatch', 'The submitted material context is invalid.')
          }
          const submissions = previous.submissions
          if (submissions.some((row) => JSON.stringify(row) === JSON.stringify(submission))) return
          const temporary = join(tempDir, `submission.${randomUUID()}`)
          try {
            writeFileDurably(temporary, `${JSON.stringify({ ...binding, submissions: [...submissions, submission] })}\n`)
            renameSync(temporary, path)
            fsyncPath(objectDir(record.id))
          } finally { rmSync(temporary, { force: true }) }
        } else {
          const temporary = join(tempDir, `submission.${randomUUID()}`)
          try {
            writeFileDurably(temporary, `${JSON.stringify({ ...binding, submissions: [submission] })}\n`)
            linkSync(temporary, path)
            fsyncPath(objectDir(record.id))
          } finally { rmSync(temporary, { force: true }) }
        }
      })
      return { id: record.selector, name: record.name, mediaType: record.mediaType,
        totalBytes: record.totalBytes, digest: record.digest }
    },
    /** Worker-only: never accept a custody id or an unsubmitted selector as a model argument. */
    resolveSubmitted(selector) {
      if (!MATERIAL_ID_PATTERN.test(String(selector ?? ''))) {
        throw new MaterialError('material_id_invalid', 'A material selector must be mat_<32 hex>.')
      }
      for (const row of this.list()) {
        const record = this.require(row.id)
        if (record.selector !== selector) continue
        const path = join(objectDir(record.id), 'submission.json')
        if (!existsSync(path)) break
        let submitted
        try { submitted = JSON.parse(readFileSync(path, 'utf8')) } catch { /* mismatch below */ }
        if (submitted?.selector !== selector || submitted?.custodyId !== record.id
          || submitted?.digest !== record.digest || submitted?.totalBytes !== record.totalBytes
          || submitted?.owner?.profile !== identity.profile || submitted?.owner?.owner !== identity.owner
          || !submitted?.agent || (record.agent && submitted.agent !== record.agent)
          || marker.agent !== submitted.agent || !Array.isArray(submitted?.submissions)
          || submitted.submissions.length === 0
          || submitted.submissions.some((row) => typeof row?.sessionKey !== 'string' || row.sessionKey === '')
          || !identity.agentFingerprint || identity.agentFingerprint !== materialAgentFingerprint(submitted.agent)) {
          throw new MaterialError('material_submission_mismatch', 'The submitted selector does not match its immutable custody, owner and version.')
        }
        try { this.verify(record.id) } catch (error) {
          if (error instanceof MaterialError) {
            throw new MaterialError(error.code, error.message.replaceAll(record.id, selector))
          }
          throw error
        }
        return record
      }
      throw new MaterialError('material_not_found', 'This selector has no submitted material in this runtime profile.')
    },
    /**
     * Store bytes an action produced, so a reference to them can be registered.
     *
     * `encoding` is the declaration the registration will carry. It is recorded rather than
     * inferred: the Gateway cannot check it and enforces it at disclosure instead, so a Worker
     * that declared `utf8` for bytes that are not UTF-8 buys a visible failure there.
     */
    putResult({ name = 'result', mediaType, encoding, bytes }) {
      return store('result', { name, mediaType, encoding, bytes, ceiling: MAX_OBJECT_BYTES, origin: 'execution' })
    },
    /**
     * A result object that references an existing material's chunks.
     *
     * The material is immutable, so the reference cannot go stale, and a copy would be a second
     * set of bytes to keep consistent for no gain.
     */
    deriveResult(materialId, { mediaType, encoding } = {}) {
      const source = ownedRecord(materialId)
      if (source === undefined) {
        throw new MaterialError('material_not_found', `${materialId} is not a material of this runtime profile.`)
      }
      const id = `res_${randomUUID().replace(/-/g, '')}`
      const now = new Date().toISOString()
      const record = {
        version: MATERIAL_STORE_VERSION,
        id,
        kind: 'result',
        name: source.name,
        mediaType: materialMediaType(mediaType ?? source.mediaType),
        encoding: encoding ?? source.encoding ?? 'base64',
        totalBytes: source.totalBytes,
        digest: source.digest,
        chunkBytes: source.chunkBytes,
        chunks: [...source.chunks],
        chunksFrom: source.chunksFrom ?? source.id,
        producedFrom: source.id,
        owner: { ...source.owner },
        disclosure: { ...source.disclosure },
        addedAt: now,
        retention: { policy: 'profile-lifetime', immutable: true, recordedAt: now, dependsOn: source.chunksFrom ?? source.id },
      }
      const staging = join(tempDir, `${id}.${randomUUID()}`)
      mkdirSync(staging, { recursive: true, mode: 0o700 })
      try {
        writeFileDurably(join(staging, 'record.json'), `${JSON.stringify(record, null, 2)}\n`)
        fsyncPath(staging)
        renameSync(staging, objectDir(id))
      } catch (error) {
        rmSync(staging, { recursive: true, force: true })
        throw error
      }
      return record
    },
    /** Metadata for this profile's own materials. Produced result objects are not listed. */
    list() {
      if (!existsSync(objectsDir)) return []
      const rows = []
      for (const entry of readdirSync(objectsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !MATERIAL_ID_PATTERN.test(entry.name)) continue
        let record
        try {
          record = ownedRecord(entry.name)
        } catch {
          // A corrupt record is not listed as a usable material; it still refuses loudly when
          // somebody names it. A list is not where a person can act on the repair.
          continue
        }
        if (record === undefined) continue
        rows.push({
          id: record.id, name: record.name, mediaType: record.mediaType,
          totalBytes: record.totalBytes, digest: record.digest, addedAt: record.addedAt,
        })
      }
      return rows.sort((left, right) => String(left.addedAt).localeCompare(String(right.addedAt)))
    },
    /** The owner-checked record, or `undefined`. Membership checks that must not read bytes use this. */
    record: ownedRecord,
    /** The record, or a named refusal. For callers that have nothing sensible to do with `undefined`. */
    require(id) {
      const record = ownedRecord(id)
      if (record === undefined) {
        throw new MaterialError('material_not_found', `${id} is not an object of this runtime profile.`)
      }
      return record
    },
    /**
     * The whole object, after everything that could make it the wrong bytes has been checked.
     *
     * `modelDestination` is required rather than optional: a caller that did not say where the
     * content is going cannot be told whether this host's own disclosure binding admits it, and
     * defaulting to the configured one would let a forgotten argument read as consent. This is
     * the host's gate, not authorization — that is the Gateway's, per read.
     */
    read(id, { modelDestination } = {}) {
      const record = this.require(id)
      const asked = normalizeModelDestination(modelDestination)
      // The recorded destination gates a file **a person added**, which is what their choice was
      // about. Bytes an action produced carry no such choice, and holding them to the model
      // endpoint that happened to be configured at production time would refuse ordinary results
      // for a reason nobody made.
      if (record.disclosure?.origin !== 'operator') return { record, bytes: readBytes(record) }
      if (asked === '' || asked !== record.disclosure?.modelDestination) {
        throw new MaterialError('material_disclosure_refused',
          `${record.id} was added for disclosure to ${JSON.stringify(record.disclosure?.modelDestination ?? '')} and this read`
          + ` is for ${JSON.stringify(asked)}. Changing the model destination does not move an existing attachment's`
          + ' permission with it.')
      }
      if (record.disclosure?.localOnly === true && !isLoopbackDestination(asked)) {
        throw new MaterialError('material_local_only',
          `${record.id} was added while this profile used a local model, so its content is not disclosed to a remote one.`)
      }
      return { record, bytes: readBytes(record) }
    },
    /**
     * A contiguous run of whole chunks, each verified against its pinned digest.
     *
     * This is what both disclosure paths are built on — the Gateway's delivery broker asks for
     * chunk indices and a local read asks for the chunks covering its authorized window — so the
     * verification lives here rather than in either caller.
     */
    chunks(id, firstChunk, chunkCount) {
      const record = this.require(id)
      if (!Number.isSafeInteger(firstChunk) || firstChunk < 0 || !Number.isSafeInteger(chunkCount) || chunkCount <= 0
        || firstChunk + chunkCount > record.chunks.length) {
        throw new MaterialError('material_chunk_range_invalid',
          `Chunks ${firstChunk}…${firstChunk + chunkCount - 1} are outside the ${record.chunks.length}-chunk manifest of ${record.id}.`)
      }
      const parts = []
      for (let index = firstChunk; index < firstChunk + chunkCount; index++) parts.push(chunkOf(record, index))
      return { record, chunks: parts }
    },
    /** Verify an object end to end without handing its bytes anywhere. */
    verify(id) {
      const record = this.require(id)
      readBytes(record)
      return record
    },
    /** Retention records for everything this profile still owns. */
    retention() {
      if (!existsSync(objectsDir)) return []
      const rows = []
      for (const entry of readdirSync(objectsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !MATERIAL_OBJECT_ID_PATTERN.test(entry.name)) continue
        let record
        try { record = ownedRecord(entry.name) } catch { continue }
        if (record === undefined) continue
        rows.push({
          id: record.id, kind: record.kind, totalBytes: record.totalBytes, digest: record.digest,
          chunkBytes: record.chunkBytes, chunks: record.chunks.length,
          ...(record.producedFrom === undefined ? {} : { producedFrom: record.producedFrom }),
          ...record.retention,
        })
      }
      return rows
    },
  }
}

/**
 * Is this text readable as the model's own words, or is it data with a shape?
 *
 * Only UTF-8 text media types are offered as text, and only when the bytes really are UTF-8 with
 * no NUL. Everything else is delivered as bytes under its media type. No extraction of any kind
 * is attempted: a DOCX or a PDF is a container this build does not open, and pretending
 * otherwise would put a plausible-looking partial reading in front of a model as if it were the
 * document.
 */
export function materialTextOf(record, bytes) {
  const type = String(record?.mediaType ?? '').toLowerCase()
  const textual = type.startsWith('text/') || type.startsWith('application/json')
    || /^application\/[a-z0-9.+-]*\+json\b/.test(type) || type.startsWith('application/xml')
    || /^application\/[a-z0-9.+-]*\+xml\b/.test(type)
  if (!textual || bytes.includes(0)) return undefined
  const text = bytes.toString('utf8')
  return Buffer.from(text, 'utf8').equals(bytes) ? text : undefined
}

/**
 * Trim a window to whole UTF-8 code points — `trimming: "utf8-code-point/1"` in the material wire.
 *
 * Two refusals rather than one convenience. A window that *starts* inside a code point is a
 * window nobody can complete, because the bytes before it are not in it; a window that becomes
 * empty after trimming is a read that produced nothing, and answering it with an empty success
 * would tell the model the object ends there. Both are named, and neither substitutes a
 * replacement character for a byte it could not place.
 */
export function trimToCodePoints(bytes, { atEnd = false } = {}) {
  if (bytes.byteLength === 0) {
    throw new MaterialError('material_window_empty', 'The authorized window contains no bytes.')
  }
  if ((bytes[0] & 0xc0) === 0x80) {
    throw new MaterialError('material_offset_split_code_point',
      'The authorized window begins inside a UTF-8 code point, so it cannot be decoded from its own bytes.')
  }
  // Walk back over the trailing continuation bytes to the lead byte they belong to, then keep
  // that whole sequence only when all of it is inside the window. Trimming the continuation
  // bytes on their own would leave a lead byte with nothing after it, which is the same defect
  // one step earlier.
  let end = bytes.byteLength
  let lead = end - 1
  while (lead >= 0 && (bytes[lead] & 0xc0) === 0x80) lead -= 1
  if (lead >= 0) {
    const first = bytes[lead]
    // `0xf8` and above start no UTF-8 sequence at all. Trimming such a byte as though it were a
    // truncated character would quietly discard a byte this window really does contain.
    if (first >= 0xf8) {
      throw new MaterialError('material_encoding_unverifiable',
        'The authorized window was declared UTF-8 and ends on a byte that begins no UTF-8 sequence.')
    }
    const width = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1
    if (!atEnd && lead + width > end) end = lead
  }
  const trimmed = bytes.subarray(0, end)
  if (trimmed.byteLength === 0) {
    throw new MaterialError('material_window_empty',
      'The authorized window holds no whole UTF-8 code point, so there is nothing to disclose from it.')
  }
  const text = trimmed.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(trimmed)) {
    throw new MaterialError('material_encoding_unverifiable',
      'The authorized window was declared UTF-8 and does not decode as UTF-8. Nothing is substituted for a byte that could not be placed.')
  }
  return { bytes: trimmed, text }
}

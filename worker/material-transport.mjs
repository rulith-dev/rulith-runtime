// SPDX-License-Identifier: Apache-2.0
/**
 * The Worker's half of the material wire (`rulith-worker-material/1`).
 *
 * Three exchanges, one property they share: **no object byte is ever sent to the Gateway as a
 * payload it keeps.** Registration sends a manifest. The delivery broker sends the chunks of one
 * bounded read, which the Gateway verifies, slices and drops. A local claim sends nothing and
 * receives an authorization for one window of one object for one recipient.
 *
 * Everything in this file either builds a request from a store record or checks an answer before
 * anything acts on it. It holds no credentials and opens no sockets — the Worker owns both, and
 * passes in a `call` that performs one authenticated private-surface request. That split is why
 * the shape checks below are testable without a network.
 */
import { MaterialError, MATERIAL_CHUNK_BYTES, MATERIAL_CUSTODY_ACKNOWLEDGEMENT, MATERIAL_DIGEST_PATTERN, isLoopbackDestination, normalizeModelDestination, trimToCodePoints } from './material-store.mjs'

export const MATERIAL_PROTOCOL = 'rulith-worker-material/1'
export const LOCAL_DELIVERY_PROTOCOL = 'rulith-local-delivery/1'
export const MATERIAL_REGISTER_PATH = '/artifact/register'
/** Two routes, not one: the broker is polled here… */
export const MATERIAL_DELIVERY_PATH = '/artifact/delivery'
/** …and answered here. One route for both directions was this side's mistake, not the wire's. */
export const MATERIAL_DELIVERY_RESULT_PATH = '/artifact/delivery/result'
export const MATERIAL_CLAIM_PATH = '/artifact/claim'
/**
 * The window and the chunk envelope, bounded together.
 *
 * A read window is at most 1 MiB, and a 1 MiB window that does **not** begin on a chunk boundary
 * spans **seventeen** 64 KiB chunks, not sixteen. Bounding the delivery by the window's byte size
 * would therefore refuse a request the Gateway may legitimately make — a ceiling that cannot
 * express its own worst case is not a ceiling, it is an outage waiting for an unaligned offset.
 * So the chunk count is the bound and the byte ceiling is derived from it.
 */
export const MAX_WINDOW_BYTES = 1024 * 1024
export const MAX_WINDOW_CHUNKS = Math.ceil(MAX_WINDOW_BYTES / MATERIAL_CHUNK_BYTES) + 1
export const MAX_DELIVERY_BYTES = MAX_WINDOW_CHUNKS * MATERIAL_CHUNK_BYTES
const ARTIFACT_REF = /^art_[0-9a-f]{32}$/
const REQUEST_ID = /^mdr_[0-9a-f]{32}$/
/**
 * A custody id as the canonical schema defines it — and `:` is deliberately not in it.
 *
 * The id is an index key the Gateway echoes back, never a location. Admitting a colon would let
 * `C:name` through a validator on a machine where that is a drive-relative path, and the only
 * thing standing between that and the filesystem would be whichever caller remembered not to join
 * it. This store never joins anything but its own `(mat|res)_<32 hex>` ids; the character is
 * refused here as well so the two agree.
 */
const CUSTODY_ID = /^[A-Za-z0-9_.-]{1,128}$/
/** The Gateway's ticket shape. Opaque, but not shapeless: a value of another shape is not one. */
const TICKET = /^mlt_[A-Za-z0-9_-]{43}$/
const PERMISSIONS = new Set(['granted', 'denied', 'absent'])

/** A custody id, checked as an index key rather than as anything that could be resolved. */
export function custodyIdOf(value) {
  if (typeof value !== 'string') return undefined
  return CUSTODY_ID.test(value) && value !== '.' && value !== '..' ? value : undefined
}

/** A ticket, checked for shape before it is carried anywhere. It is still opaque. */
export function localTicketOf(value) {
  const ticket = typeof value === 'string' ? value.trim() : ''
  return TICKET.test(ticket) ? ticket : undefined
}

/**
 * The current Source material permission, as the Gateway states it beside a delivery request.
 *
 * Every member is required and every permission is one of the three named values. A partially
 * stated permission is not a weaker permission, it is an unreadable one — and the whole reason
 * this block travels is so the custodian can refuse without guessing.
 */
export function sourceMaterialPermission(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { sourceRecordId, register, proxy, localRead, refusal } = value
  const wellFormed = typeof sourceRecordId === 'string' && typeof register === 'boolean'
    && PERMISSIONS.has(proxy) && PERMISSIONS.has(localRead)
    && (refusal === null || refusal === 'source_material_absent' || refusal === 'source_material_denied')
  return wellFormed ? { sourceRecordId, register, proxy, localRead, refusal } : undefined
}

/**
 * The registration body for one durable local object.
 *
 * Built from the store record rather than from anything a caller passes beside it: the manifest,
 * the digest and the length are properties of bytes already on disk, and a registration that
 * could state them independently would be a second description able to disagree with the first.
 */
export function registrationBody(record, executionGrant) {
  if (!CUSTODY_ID.test(String(record?.id ?? ''))) {
    throw new MaterialError('material_custody_id_invalid', 'A custody id is an opaque label this host generated.')
  }
  if (record.chunkBytes !== MATERIAL_CHUNK_BYTES) {
    throw new MaterialError('material_chunk_size_mismatch',
      `This object is chunked at ${record.chunkBytes} and the wire fixes ${MATERIAL_CHUNK_BYTES}.`)
  }
  const expected = Math.ceil(record.totalBytes / MATERIAL_CHUNK_BYTES)
  if (record.chunks.length !== expected) {
    throw new MaterialError('material_manifest_invalid',
      `A ${record.totalBytes}-byte object has ${expected} chunks and this manifest states ${record.chunks.length}.`)
  }
  return {
    protocol: MATERIAL_PROTOCOL,
    executionGrant,
    custodyId: record.id,
    mediaType: record.mediaType,
    encoding: record.encoding,
    totalBytes: record.totalBytes,
    digest: record.digest,
    chunkBytes: record.chunkBytes,
    chunkDigests: [...record.chunks],
    custody: { durable: true, acknowledged: MATERIAL_CUSTODY_ACKNOWLEDGEMENT },
  }
}

/**
 * The five fields registration answers with, checked against the object they describe.
 *
 * The comparison is the point rather than the parse: a reference is only worth putting in a
 * receipt if the service agrees about which bytes it refers to. An answer that names a different
 * length, a different digest or a different media type is a reference to something else.
 */
export function registrationResult(answer, record) {
  const payload = answer?.payload ?? answer
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  if (!ARTIFACT_REF.test(String(payload.ref ?? ''))) return undefined
  if (payload.digest !== record.digest || payload.totalBytes !== record.totalBytes
    || payload.mediaType !== record.mediaType || payload.encoding !== record.encoding) return undefined
  return { ref: payload.ref }
}

/**
 * One delivery request, or `null` for the ordinary idle answer.
 *
 * Every field is checked before a chunk is read, because this is the one message that tells this
 * process which of its own bytes to go and fetch. A request whose range is not a contiguous run
 * of whole chunks is refused here rather than answered with whatever the numbers happened to
 * select.
 */
export function deliveryRequestOf(answer) {
  const delivery = answer?.delivery
  if (delivery === null || delivery === undefined) return null
  if (typeof delivery !== 'object' || Array.isArray(delivery)) {
    throw new MaterialError('material_delivery_malformed', 'The delivery poll answered with a request this Worker cannot read.')
  }
  const { requestId, ref, chunkBytes, firstChunk, chunkCount, digest, chunkDigests, deadlineMillis } = delivery
  const custodyId = custodyIdOf(delivery.custodyId)
  const sourceMaterial = sourceMaterialPermission(delivery.sourceMaterial)
  const wellFormed = REQUEST_ID.test(String(requestId)) && ARTIFACT_REF.test(String(ref))
    && custodyId !== undefined && chunkBytes === MATERIAL_CHUNK_BYTES
    && Number.isSafeInteger(firstChunk) && firstChunk >= 0
    && Number.isSafeInteger(chunkCount) && chunkCount > 0 && chunkCount <= MAX_WINDOW_CHUNKS
    && MATERIAL_DIGEST_PATTERN.test(String(digest))
    && Array.isArray(chunkDigests) && chunkDigests.length === chunkCount
    && chunkDigests.every((value) => MATERIAL_DIGEST_PATTERN.test(String(value)))
    && Number.isSafeInteger(deadlineMillis) && deadlineMillis > 0
  if (!wellFormed) {
    throw new MaterialError('material_delivery_malformed',
      'The delivery request does not state one contiguous run of whole chunks of one object.')
  }
  // The current Source permission travels **with** the request, and its absence is refused rather
  // than treated as permission. A custodian that could not read it would have to choose between
  // sending bytes it cannot justify and refusing a legitimate read; refusing the malformed
  // request is the only answer that is neither.
  if (sourceMaterial === undefined) {
    throw new MaterialError('material_delivery_malformed',
      'The delivery request states no current Source material permission. An authenticated request is not permission.')
  }
  return {
    requestId: String(requestId), ref: String(ref), custodyId,
    firstChunk, chunkCount, digest: String(digest), chunkDigests: chunkDigests.map(String),
    deadlineMillis, sourceMaterial,
    ...(Number.isSafeInteger(delivery.lastChunkBytes) ? { lastChunkBytes: delivery.lastChunkBytes } : {}),
  }
}

/**
 * Whether these bytes may leave this machine at all, asked before any of them is read.
 *
 * **An authenticated request is not permission.** The Gateway asking for chunks proves who is
 * asking and nothing about whether the Source may be proxied, so the custodian checks two things
 * that only it and the request together can answer:
 *
 *   · the Source's **current** `proxy` permission, which the request carries — `denied` and
 *     `absent` each refuse, and neither ever reads as a grant;
 *   · this host's **own** record of the file. A material added while this profile used a model on
 *     this machine is local-only, and a proxied read is by definition a read that leaves. The
 *     operator chose that when they added the file, and a later off-machine grant on the Source
 *     does not reach back and re-decide it.
 *
 * The refusal reason is the one the wire admits for "I hold these bytes and may not send them":
 * the waiting read is told the permission is withdrawn rather than left to time out.
 */
export function assertProxyPermitted(request, record) {
  if (request.sourceMaterial.proxy !== 'granted') {
    throw new MaterialError('material_permission_withdrawn',
      `Source ${JSON.stringify(request.sourceMaterial.sourceRecordId)} states off-machine disclosure as`
      + ` ${JSON.stringify(request.sourceMaterial.proxy)}, so these bytes are not sent.`)
  }
  if (record?.disclosure?.origin === 'operator' && record.disclosure.localOnly === true) {
    throw new MaterialError('material_permission_withdrawn',
      `${record.id} is a file somebody added while this profile used a model on this machine, so it is local-only.`
      + ' A proxied read moves the bytes off the machine, and a Source granted off-machine disclosure afterwards does'
      + ' not reach back and re-decide what that person chose.')
  }
  return true
}

/**
 * The chunks a delivery request asked for, proved against **both** manifests.
 *
 * The store already verifies each chunk against its own pinned digest. This additionally compares
 * the request's echoed digests, so a request that names this object's chunks but somebody else's
 * digests is refused before any byte is sent rather than after the Gateway rejects them.
 */
export function deliveryChunks(store, request) {
  const { record, chunks } = store.chunks(request.custodyId, request.firstChunk, request.chunkCount)
  // Permission before bytes. `store.chunks` has read them off the disk by now, but nothing has
  // left this process, and this is the last point at which that is still true.
  assertProxyPermitted(request, record)
  const { chunks: pinned } = record
  for (const [offset, digest] of request.chunkDigests.entries()) {
    if (pinned[request.firstChunk + offset] !== digest) {
      throw new MaterialError('material_chunk_digest_mismatch',
        `Chunk ${request.firstChunk + offset} of ${record.id} is pinned to a different digest than the delivery request states.`)
    }
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  if (chunks.length > MAX_WINDOW_CHUNKS || total > MAX_DELIVERY_BYTES) {
    throw new MaterialError('material_delivery_too_large',
      `This delivery would carry ${chunks.length} chunks and ${total} bytes; one read carries at most`
      + ` ${MAX_WINDOW_CHUNKS} chunks and ${MAX_DELIVERY_BYTES} bytes.`)
  }
  return chunks.map((chunk, offset) => ({ index: request.firstChunk + offset, bytes: chunk.toString('base64') }))
}

/**
 * The authorization a claim returns, checked field by field before anything is disclosed.
 *
 * `modelDisclosure` is mandatory and is checked as its own thing. Local custody is permission to
 * hold bytes on this machine; it is not permission to forward them to a model somewhere else.
 * An authorization that omits it is refused rather than read as granted — this is the one field
 * whose absence would otherwise turn a local-only object into a remote disclosure.
 */
export function claimAuthorization(answer) {
  const payload = answer?.payload ?? answer
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new MaterialError('local_claim_malformed', 'The claim answered with a payload this host cannot read.')
  }
  const custodyId = custodyIdOf(payload.custodyId)
  const wellFormed = payload.protocol === LOCAL_DELIVERY_PROTOCOL
    && ARTIFACT_REF.test(String(payload.ref)) && custodyId !== undefined
    && typeof payload.mediaType === 'string' && payload.mediaType !== ''
    && (payload.encoding === 'utf8' || payload.encoding === 'base64')
    && Number.isSafeInteger(payload.totalBytes) && payload.totalBytes > 0
    && MATERIAL_DIGEST_PATTERN.test(String(payload.digest))
    && payload.chunkBytes === MATERIAL_CHUNK_BYTES
    && Number.isSafeInteger(payload.firstChunk) && payload.firstChunk >= 0
    && Array.isArray(payload.chunkDigests)
    && payload.chunkDigests.length > 0 && payload.chunkDigests.length <= MAX_WINDOW_CHUNKS
    && payload.chunkDigests.every((value) => MATERIAL_DIGEST_PATTERN.test(String(value)))
    && Number.isSafeInteger(payload.offset) && payload.offset >= 0
    // Bounded with the chunk envelope rather than independently of it: an authorization for a
    // window this host could not cover in whole chunks is one it could not honour.
    && Number.isSafeInteger(payload.maximumLength)
    && payload.maximumLength > 0 && payload.maximumLength <= MAX_WINDOW_BYTES
    && payload.trimming === 'utf8-code-point/1'
  if (!wellFormed) {
    throw new MaterialError('local_claim_malformed',
      'The claim payload does not state one authorized window of one object in the shape this protocol fixes.')
  }
  if (!PERMISSIONS.has(payload.modelDisclosure)) {
    throw new MaterialError('local_claim_disclosure_unstated',
      'The claim payload does not state the current off-machine disclosure permission. Local custody is permission to'
      + ' hold these bytes here, not to forward them to a model elsewhere, and an unstated permission is not a grant.')
  }
  return {
    protocol: payload.protocol, ref: payload.ref, custodyId,
    mediaType: payload.mediaType, encoding: payload.encoding, totalBytes: payload.totalBytes,
    digest: payload.digest, chunkBytes: payload.chunkBytes, firstChunk: payload.firstChunk,
    chunkDigests: payload.chunkDigests.map(String), offset: payload.offset,
    maximumLength: payload.maximumLength, trimming: payload.trimming,
    modelDisclosure: payload.modelDisclosure,
  }
}

/**
 * Whether one object's bytes may leave this machine, read from the Source permission in force.
 *
 * The rule is one-directional: only an explicit granted permission from the actual Source record
 * admits it. `denied` is a recorded refusal and `absent` means no record was found — including
 * the Source-free case, where there is no Source to have granted anything — and each is refused
 * under its own name, so that adding, renaming or normalizing a policy key can never turn a
 * refusal into a silent allow.
 *
 * It used to gate an upload of payload bytes to the service. There is no such upload any more;
 * what it gates now is *disclosure to a model that is not on this machine*, which is the same
 * question about the same permission at the moment it actually matters. The committed
 * cross-repository permission rows pin this function's answers.
 */
export function uploadDecision(permission, sourceRecordId) {
  const source = typeof sourceRecordId === 'string' ? sourceRecordId : ''
  if (permission === 'granted' && source !== '') {
    return { sourceRecordId: source, permission: 'granted', upload: true, refusal: null }
  }
  if (permission === 'denied') {
    return { sourceRecordId: source, permission: 'denied', upload: false, refusal: 'source_off_machine_denied' }
  }
  return { sourceRecordId: source, permission: 'absent', upload: false, refusal: 'source_permission_required' }
}

/**
 * Where this window's bytes may go, decided before they are read.
 *
 * Two independent permissions, and both must hold.
 *
 *   · The Gateway's `modelDisclosure` says whether this Source's bytes may leave the machine at
 *     all, **now**. Holding custody locally is permission to keep the bytes here; it has never
 *     been permission to forward them to a model somewhere else.
 *   · The host's own record says which model destination the person who added the file was
 *     disclosing it to. Editing the model URL afterwards does not carry that permission with it.
 *
 * A loopback model needs the first to be nothing in particular, because nothing leaves. Anything
 * else needs a current grant, and no signature, ticket or approval obtained earlier substitutes
 * for one.
 */
export function assertDisclosurePermitted(authorization, { modelDestination, recordDisclosure, sourceRecordId }) {
  const destination = normalizeModelDestination(modelDestination)
  if (destination === '') {
    throw new MaterialError('material_destination_unstated',
      'A local read states the model destination its content would reach. An unstated destination is not disclosed to.')
  }
  if (recordDisclosure !== undefined && destination !== normalizeModelDestination(recordDisclosure)) {
    throw new MaterialError('material_disclosure_refused',
      `This object was added for disclosure to ${JSON.stringify(normalizeModelDestination(recordDisclosure))} and this read`
      + ` is for ${JSON.stringify(destination)}. Changing the model endpoint does not carry an existing attachment's`
      + ' permission with it.')
  }
  if (isLoopbackDestination(destination)) return destination
  const decided = uploadDecision(authorization.modelDisclosure, String(sourceRecordId ?? authorization.custodyId ?? ''))
  if (!decided.upload) {
    throw new MaterialError(decided.refusal,
      `This object is held on this machine and the model configured for this host is at ${destination}, which is not.`
      + ` The Gateway states off-machine disclosure as ${JSON.stringify(authorization.modelDisclosure)}, so the bytes stay here.`)
  }
  return destination
}

/**
 * The nine-field `ReadArtifactResult` a local read produces, identical in shape to a proxy read.
 *
 * The window is the Gateway's, not this host's: `offset` and `maximumLength` come from the
 * authorization and nothing here reads outside them. `maximumLength` is a bound rather than a
 * length because the Gateway holds no bytes and cannot know where the code points land, so the
 * trimming happens here and `length` falls out of it.
 */
export function localReadResult(authorization, chunks) {
  const window = Math.min(authorization.maximumLength, authorization.totalBytes - authorization.offset)
  if (window <= 0) {
    throw new MaterialError('material_window_empty', 'The authorized window begins at or past the end of this object.')
  }
  const held = Buffer.concat(chunks)
  const start = authorization.offset - authorization.firstChunk * authorization.chunkBytes
  if (start < 0 || start + window > held.byteLength) {
    throw new MaterialError('material_chunk_range_invalid',
      'The chunks this host holds do not cover the window the Gateway authorized.')
  }
  const slice = held.subarray(start, start + window)
  const fragment = authorization.encoding === 'utf8'
    ? trimToCodePoints(slice, { atEnd: authorization.offset + window === authorization.totalBytes }) : { bytes: slice }
  const length = fragment.bytes.byteLength
  const complete = authorization.offset + length === authorization.totalBytes
  return {
    ref: authorization.ref,
    mediaType: authorization.mediaType,
    encoding: authorization.encoding,
    data: authorization.encoding === 'utf8' ? fragment.text : fragment.bytes.toString('base64'),
    offset: authorization.offset,
    nextOffset: complete ? null : authorization.offset + length,
    totalBytes: authorization.totalBytes,
    complete,
    truncated: !complete,
  }
}

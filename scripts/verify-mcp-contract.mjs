// SPDX-License-Identifier: Apache-2.0
/**
 * Read the vendored MCP contract bundle, and refuse anything that is not one.
 *
 * The bundle is what the three repositories agree on — `protocol/mcp-surface.json`, the
 * board / query-context / MCP-meta / artifact-read schemas, and the Core `Agent*`
 * definitions — exported together from one committed ref of the contract repository. This
 * Runtime **consumes** it and authors no part of it.
 *
 * ## What this checks, and what it does not
 *
 * Provenance is established **once, at vendor time**, by the contract repository's own
 * verifier, which resolves the named commit in the real Git object store and compares every
 * file against the blob it names. `scripts/sync-mcp-contract.mjs` will not write a bundle
 * that has not passed it. Nothing here re-does that: a self-reported digest cannot prove
 * where bytes came from, and this module does not pretend otherwise.
 *
 * What it does prove is that the vendored copy is **internally coherent and untampered**:
 *
 *   · every carried file hashes to the digest recorded beside it;
 *   · `surface` is the parsed content of the carried `protocol/mcp-surface.json`, so the
 *     membership list is the hashed bytes rather than a second copy beside them;
 *   · every materialized `tools[]` entry corresponds to a `surface.tools[]` entry with the
 *     same target and operation, and its `inputSchemaRef` resolves inside the carried
 *     schema file it names;
 *   · each materialized schema still agrees with that resolved definition on the skeleton a
 *     materializer does not touch — type, required, additionalProperties, and the set of
 *     property names — so a rewritten tool projection cannot ride along on intact file
 *     digests;
 *   · the metadata schema's `ToolName` enum is the same membership again.
 *
 * After installation the packaged bytes are bound by `artifact-manifest.json`, which is the
 * integrity story for the shipped file rather than for its provenance.
 *
 * ## No fallbacks
 *
 * A missing bundle is an error. There is no "not vendored yet" branch and no hand-written
 * membership to fall back to: a Runtime that cannot read the contract cannot know what its
 * public surface is, and guessing is the failure this whole mechanism exists to prevent.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const BUNDLE_SCHEMA = 'rulith-mcp-contract-bundle/v1'
export const SURFACE_SCHEMA = 'rulith-mcp-surface/v2'
export const BUNDLE_PATH = 'protocol/mcp-contract.json'
export const SURFACE_FILE = 'protocol/mcp-surface.json'

/** Every reason a bundle can be rejected, so a caller can say which one it hit. */
export class ContractError extends Error {}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Resolve a `file#/json/pointer` reference against the bundle's carried files. */
function resolveRef(reference, parsedFiles, path) {
  const [file, pointer] = String(reference).split('#')
  const source = parsedFiles.get(file)
  if (source === undefined) {
    throw new ContractError(`${path}: ${reference} points at ${file}, which the bundle does not carry.`)
  }
  if (pointer === undefined || !pointer.startsWith('/')) {
    throw new ContractError(`${path}: ${reference} has no JSON pointer.`)
  }
  let node = source
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/gu, '/').replace(/~0/gu, '~')
    node = isObject(node) ? node[key] : undefined
    if (node === undefined) throw new ContractError(`${path}: ${reference} does not resolve inside ${file}.`)
  }
  if (!isObject(node)) throw new ContractError(`${path}: ${reference} resolves to something that is not a schema object.`)
  return node
}

/** The parts of a schema a materializer must preserve; the rest it may legitimately rewrite. */
const skeletonOf = (schema) => JSON.stringify({
  type: schema.type ?? null,
  required: Array.isArray(schema.required) ? [...schema.required].sort() : null,
  additionalProperties: schema.additionalProperties ?? null,
  properties: isObject(schema.properties) ? Object.keys(schema.properties).sort() : null,
  branches: ['oneOf', 'anyOf', 'allOf'].map((key) => (Array.isArray(schema[key]) ? schema[key].length : 0)),
})

/**
 * Validate a parsed bundle and return everything this Runtime consumes from it.
 *
 * Returns `{ sourceCommit, protocolVersion, metadataNamespace, tools, schemas,
 * recoveryStates, clientCapabilities, queryProfiles, queryContext, files }`. `tools` is the
 * `[{name, target, operation}]` membership in the order the contract gives it.
 */
export function readContractBundle(bundle, { path = BUNDLE_PATH } = {}) {
  if (!isObject(bundle)) throw new ContractError(`${path} is not an object.`)
  if (bundle.schema !== BUNDLE_SCHEMA) {
    throw new ContractError(`${path} declares schema ${JSON.stringify(bundle.schema)}; this Runtime reads ${BUNDLE_SCHEMA}.`)
  }
  if (typeof bundle.sourceCommit !== 'string' || !/^[0-9a-f]{40}$/u.test(bundle.sourceCommit)) {
    throw new ContractError(`${path} carries sourceCommit ${JSON.stringify(bundle.sourceCommit)},`
      + ' which is not a full 40-character commit id. A contract that cannot name the commit it was exported from'
      + ' cannot be reconciled with the repository that authored it.')
  }
  if (!isObject(bundle.files) || Object.keys(bundle.files).length === 0) {
    throw new ContractError(`${path} carries no files; there would be nothing to reconcile against.`)
  }

  // 1. Integrity of the vendored copy.
  const parsedFiles = new Map()
  for (const [sourcePath, entry] of Object.entries(bundle.files)) {
    if (!isObject(entry) || typeof entry.content !== 'string' || typeof entry.sha256 !== 'string') {
      throw new ContractError(`${path}: ${sourcePath} is missing its content or its sha256.`)
    }
    const actual = sha256(entry.content)
    if (actual !== entry.sha256) {
      throw new ContractError(`${path}: ${sourcePath} does not match the digest recorded beside it`
        + ` (recorded ${entry.sha256}, computed ${actual}). The bundle is refused whole rather than in part.`)
    }
    if (sourcePath.endsWith('.json')) {
      try { parsedFiles.set(sourcePath, JSON.parse(entry.content)) } catch (error) {
        throw new ContractError(`${path}: ${sourcePath} is not readable JSON (${String(error?.message ?? error)}).`)
      }
    }
  }

  // 2. The surface is the carried file, not a second copy beside it.
  const carriedSurface = parsedFiles.get(SURFACE_FILE)
  if (carriedSurface === undefined) throw new ContractError(`${path} carries no ${SURFACE_FILE}.`)
  if (!isObject(bundle.surface)) throw new ContractError(`${path} carries no surface projection.`)
  if (JSON.stringify(bundle.surface) !== JSON.stringify(carriedSurface)) {
    throw new ContractError(`${path}: the surface projection differs from the carried ${SURFACE_FILE}.`
      + ' Membership must be the hashed bytes, not a copy that can drift from them.')
  }
  if (carriedSurface.schema !== SURFACE_SCHEMA) {
    throw new ContractError(`${path}: ${SURFACE_FILE} declares schema ${JSON.stringify(carriedSurface.schema)}; expected ${SURFACE_SCHEMA}.`)
  }
  const protocolVersion = carriedSurface.protocolVersion
  if (typeof protocolVersion !== 'string' || protocolVersion === '') {
    throw new ContractError(`${path}: ${SURFACE_FILE} names no protocolVersion.`)
  }
  const metadataNamespace = carriedSurface.metadata?.namespace
  if (typeof metadataNamespace !== 'string' || metadataNamespace === '') {
    throw new ContractError(`${path}: ${SURFACE_FILE} names no metadata namespace.`)
  }
  const declared = Array.isArray(carriedSurface.tools) ? carriedSurface.tools : []
  if (declared.length === 0) throw new ContractError(`${path}: ${SURFACE_FILE} lists no tools.`)

  // 3. The materialized tools are those tools, with schemas that resolve where they claim.
  const materialized = Array.isArray(bundle.tools) ? bundle.tools : []
  if (materialized.length !== declared.length) {
    throw new ContractError(`${path}: ${materialized.length} materialized tool(s) against ${declared.length} declared.`)
  }
  const schemas = []
  for (const [index, tool] of materialized.entries()) {
    const entry = declared[index]
    if (tool?.name !== entry?.name || tool?.target !== entry?.target || (tool?.operation ?? null) !== (entry?.operation ?? null)) {
      throw new ContractError(`${path}: materialized tool ${JSON.stringify(tool?.name)} does not match the declared`
        + ` ${JSON.stringify(entry?.name)} (${JSON.stringify(entry?.target)}/${JSON.stringify(entry?.operation ?? null)}).`)
    }
    if (entry.target !== 'core' && entry.target !== 'artifact' && entry.target !== 'operation') {
      throw new ContractError(`${path}: ${entry.name} declares dispatch target ${JSON.stringify(entry.target)}.`)
    }
    if (!isObject(tool.inputSchema)) throw new ContractError(`${path}: ${entry.name} carries no materialized inputSchema.`)
    if (tool.inputSchema.$schema !== 'http://json-schema.org/draft-07/schema#') {
      throw new ContractError(`${path}: ${entry.name} does not declare draft-07 explicitly`
        + ` (carries ${JSON.stringify(tool.inputSchema.$schema ?? null)}).`)
    }
    // The materializer inlines `$ref` targets under generated `$defs` names, so the
    // definitions cannot be compared byte for byte. The skeleton can: a projection that
    // gained a property, lost a requirement or changed its type is a different contract,
    // and intact file digests would otherwise let that ride along unnoticed.
    const source = resolveRef(entry.inputSchemaRef, parsedFiles, path)
    if (skeletonOf(source) !== skeletonOf(tool.inputSchema)) {
      throw new ContractError(`${path}: ${entry.name}'s materialized schema no longer matches ${entry.inputSchemaRef}`
        + ` (source ${skeletonOf(source)} against materialized ${skeletonOf(tool.inputSchema)}).`
        + ' A rewritten tool projection may not ride along on unchanged file digests.')
    }
    schemas.push({ name: entry.name, inputSchema: tool.inputSchema })
  }

  // 4. The metadata schema, and the membership it repeats.
  if (!isObject(bundle.metadata)) throw new ContractError(`${path} carries no host metadata schema.`)
  const names = declared.map((entry) => entry.name)
  const toolNameEnum = bundle.metadata.$defs?.ToolName?.enum
  if (!Array.isArray(toolNameEnum) || JSON.stringify([...toolNameEnum].sort()) !== JSON.stringify([...names].sort())) {
    throw new ContractError(`${path}: the metadata ToolName enum ${JSON.stringify(toolNameEnum ?? null)}`
      + ` is not the tool membership ${JSON.stringify(names)}.`)
  }
  const recoveryStates = bundle.metadata.$defs?.RecoveryState?.enum
  if (!Array.isArray(recoveryStates) || recoveryStates.length === 0 || !recoveryStates.every((state) => typeof state === 'string')) {
    throw new ContractError(`${path}: the metadata schema declares no RecoveryState enum.`)
  }
  const capabilities = bundle.metadata.$defs?.ClientCapabilities
  if (!isObject(capabilities) || !isObject(capabilities.properties)) {
    throw new ContractError(`${path}: the metadata schema declares no ClientCapabilities shape.`)
  }
  const clientCapabilities = {}
  for (const [name, shape] of Object.entries(capabilities.properties)) {
    if (!isObject(shape) || shape.const === undefined) {
      throw new ContractError(`${path}: ClientCapabilities.${name} has no constant value for a client to declare.`)
    }
    clientCapabilities[name] = shape.const
  }
  for (const name of Array.isArray(capabilities.required) ? capabilities.required : []) {
    if (!Object.hasOwn(clientCapabilities, name)) {
      throw new ContractError(`${path}: ClientCapabilities requires ${name}, which it does not define.`)
    }
  }

  if (!isObject(bundle.queryProfiles)) {
    throw new ContractError(`${path} carries no queryProfiles; the audience set is part of the contract.`)
  }
  if (!isObject(bundle.queryContext)) throw new ContractError(`${path} carries no queryContext shape.`)

  return {
    sourceCommit: bundle.sourceCommit,
    protocolVersion,
    metadataNamespace,
    tools: declared.map((entry) => ({
      name: entry.name,
      target: entry.target,
      ...(entry.operation === undefined ? {} : { operation: entry.operation }),
    })),
    schemas,
    recoveryStates: [...recoveryStates],
    clientCapabilities,
    metadata: bundle.metadata,
    queryProfiles: bundle.queryProfiles,
    queryContext: bundle.queryContext,
    files: bundle.files,
  }
}

/** The vendored bundle. A Runtime without one does not know its own public surface. */
export function loadContractBundle(root = resolve(import.meta.dirname, '..')) {
  const path = resolve(root, BUNDLE_PATH)
  let text
  try { text = readFileSync(path, 'utf8') } catch (error) {
    throw new ContractError(`${BUNDLE_PATH} could not be read (${String(error?.message ?? error)}).`
      + ' The vendored MCP contract is what tells this Runtime which tools exist and what they accept;'
      + ' it is not optional and there is nothing to fall back to.'
      + ' Re-vendor it with: node scripts/sync-mcp-contract.mjs <bundle.json> --verifier <contract-repo>/scripts/verify-mcp-contract.mjs')
  }
  let parsed
  try { parsed = JSON.parse(text) } catch (error) {
    throw new ContractError(`${BUNDLE_PATH} is not readable JSON: ${String(error?.message ?? error)}`)
  }
  return readContractBundle(parsed, { path: BUNDLE_PATH })
}

if (process.argv[1]?.endsWith('verify-mcp-contract.mjs')) {
  const bundle = loadContractBundle(process.argv[2] === undefined ? undefined : resolve(process.argv[2]))
  console.log(`${BUNDLE_PATH}: ${bundle.tools.length} tool(s) from ${bundle.sourceCommit}`
    + ` · MCP ${bundle.protocolVersion} · metadata ${bundle.metadataNamespace}`
    + ` · ${Object.keys(bundle.files).length} file(s) verified against their digests and against the surface they carry.`)
}

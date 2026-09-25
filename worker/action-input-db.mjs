import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

// The bytes, not a Worker-authored catalog name, are the compatibility identity.
const catalogBytes = readFileSync(new URL('../protocol/action-input-guards.json', import.meta.url))
export const guardCatalogDigest = 'sha256:' + createHash('sha256').update(catalogBytes).digest('hex')
const catalog = JSON.parse(catalogBytes)
const oldCatalogBytes = readFileSync(new URL('../protocol/action-input-guards-v1.json', import.meta.url))
export const legacyGuardCatalogDigest = 'sha256:' + createHash('sha256').update(oldCatalogBytes).digest('hex')
const oldCatalog = JSON.parse(oldCatalogBytes)
const ENUM = 'rulith.value.enum@1'
const TEXT = 'rulith.payload.bounded-text@1'
const LOCAL_MATERIAL = 'rulith.payload.local-material@1'
if (catalog.format !== 'rulith-action-input-guards/1'
    || ![ENUM, TEXT, LOCAL_MATERIAL].every(id => catalog.guards.some(guard => guard.id === id))
    || legacyGuardCatalogDigest !== 'sha256:55d92d40901868ac10ba2198f1778ec550899a51e218561c90b91b7816997f9f'
    || ![ENUM, TEXT].every(id => JSON.stringify(oldCatalog.guards.find(guard => guard.id === id))
      === JSON.stringify(catalog.guards.find(guard => guard.id === id)))) {
  throw new Error('The vendored Action input guard catalog is unreadable')
}

const identifier = '[a-z_][a-z0-9_]*'
const slot = '\\{([a-z][a-z0-9_]*)\\}'
const assignment = new RegExp(`^${identifier}\\s*=\\s*${slot}$`, 'i')
const condition = new RegExp(`^${identifier}\\s*=\\s*${slot}$`, 'i')
// The DB compiler has no deterministic omitted-value semantics for a SQL
// placeholder. This phase supports only required scalar slots.
const scalar = type => ['string', 'number', 'boolean'].includes(type)
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
const same = (a, b) => JSON.stringify(sort(a)) === JSON.stringify(sort(b))
function sort(value) {
  if (Array.isArray(value)) return value.map(sort)
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]))
  return value
}

// Deliberately narrow: one table, literal identifiers, value placeholders only, a
// grounded identity and version in the WHERE clause, and no expression language.
export function fixedUpdateShape(sql) {
  if (typeof sql !== 'string' || /[;'"`]|--|\/\*/.test(sql)) return undefined
  const columns = `${identifier}(?:\\s*,\\s*${identifier})*`
  const match = new RegExp(`^\\s*UPDATE\\s+${identifier}\\s+SET\\s+(.+?)\\s+WHERE\\s+(.+?)\\s+RETURNING\\s+(${columns})\\s*$`, 'i').exec(sql)
  if (!match) return undefined
  const set = match[1].split(/\s*,\s*/).map(part => assignment.exec(part)?.[1])
  const where = match[2].split(/\s+AND\s+/i).map(part => condition.exec(part)?.[1])
  if (set.length < 1 || where.length < 2 || [...set, ...where].some(name => !name)
      || new Set([...set, ...where]).size !== set.length + where.length) return undefined
  return { set, where, columns: match[3].split(/\s*,\s*/) }
}

export function fixedSelectShape(sql) {
  if (typeof sql !== 'string' || /[;'"`]|--|\/\*/.test(sql)) return undefined
  const columns = `${identifier}(?:\\s*,\\s*${identifier})*`
  const match = new RegExp(`^\\s*SELECT\\s+(${columns})\\s+FROM\\s+${identifier}\\s+WHERE\\s+(.+?)\\s*$`, 'i').exec(sql)
  if (!match) return undefined
  const where = match[2].split(/\s+AND\s+/i).map(part => condition.exec(part)?.[1])
  return where.length > 0 && where.every(Boolean) && new Set(where).size === where.length
    ? { where, columns: match[1].split(/\s*,\s*/) } : undefined
}

function returnsFromColumns(def, columns) {
  return Array.isArray(def.returns) && def.returns.length > 0 && def.returns.every(mapping =>
    plain(mapping) && plain(mapping.args) && Object.values(mapping.args).every(source =>
      typeof source === 'string' && source.startsWith('$') && columns.includes(source.slice(1))))
}

function eligible(def, kind) {
  if (!def || !Array.isArray(def.sourceTypes) || !same(def.sourceTypes, ['db'])
      || !plain(def.params) || Object.values(def.params).some(type => !scalar(type))) return false
  if (kind === 'read') {
    const shape = fixedSelectShape(def.entry)
    return def.adapter === 'db-query' && (def.kind === undefined || def.kind === 'read') && !!shape
      && returnsFromColumns(def, shape.columns)
      && shape.where.every(name => Object.hasOwn(def.params, name))
      && Object.keys(def.params).every(name => shape.where.includes(name))
  }
  if (kind === 'write') {
    const shape = fixedUpdateShape(def.entry)
    return def.adapter === 'db-exec-fenced' && (def.kind === undefined || def.kind === 'write') && !!shape
      && returnsFromColumns(def, shape.columns)
      && [...shape.set, ...shape.where].every(name => Object.hasOwn(def.params, name))
      && Object.keys(def.params).every(name => [...shape.set, ...shape.where].includes(name))
  }
  return false
}

export function toolContractFingerprint(descriptor) {
  const contract = { exec: descriptor.id, kind: descriptor.kind,
    sourceTypes: descriptor.sourceTypes, params: descriptor.params, returns: descriptor.returns }
  if (httpTextWriteEligible(descriptor)) contract.fence = descriptor.fence
  return 'sha256:' + createHash('sha256').update(JSON.stringify(sort(contract))).digest('hex')
}

const HTTP_TEXT = 'rulith-http-text-write/1'
const HTTP_SELECTED_TEXT = 'rulith-http-text-write/2'
function httpTextWriteEligible(tool) {
  const fence = tool?.fence, profile = fence?.textWrite, completion = fence?.completion
  if (tool?.adapter !== 'http' || tool.kind !== 'write' || !same(tool.sourceTypes, ['http'])
      || !plain(fence) || Object.keys(fence).some(key => !['method', 'completion', 'timeoutMs', 'maxResponseBytes', 'textWrite'].includes(key))
      || !plain(profile) || !same(Object.keys(profile).sort(), ['contentType', 'format', 'method', 'payloadParam', 'relativePath', 'targetParam'])
      || ![HTTP_TEXT, HTTP_SELECTED_TEXT].includes(profile.format) || profile.method !== 'PUT' || fence.method !== 'PUT'
      || profile.contentType !== 'text/plain; charset=utf-8'
      || typeof profile.targetParam !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.targetParam)
      || typeof profile.payloadParam !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.payloadParam)
      || profile.targetParam === profile.payloadParam || !plain(tool.params)
      || !same(tool.params, { [profile.targetParam]: 'string',
        [profile.payloadParam]: profile.format === HTTP_SELECTED_TEXT ? 'json' : 'string' })
      || typeof profile.relativePath !== 'string' || profile.relativePath !== tool.entry
      || !profile.relativePath.startsWith('/') || profile.relativePath.startsWith('//')
      || /[?#\\%]/.test(profile.relativePath)) return false
  const segments = profile.relativePath.slice(1).split('/')
  if (segments.filter(segment => segment === `{${profile.targetParam}}`).length !== 1
      || segments.some(segment => segment !== `{${profile.targetParam}}`
        && (!/^[A-Za-z0-9._~-]+$/.test(segment) || segment === '.' || segment === '..'))) return false
  if (['timeoutMs', 'maxResponseBytes'].some(key => fence[key] !== undefined
      && (!Number.isSafeInteger(fence[key]) || fence[key] < 1))) return false
  if (!plain(completion) || !same(Object.keys(completion).sort(), ['json', 'stage', 'statuses'])
      || completion.stage !== 'terminal' || !Array.isArray(completion.statuses)
      || completion.statuses.length < 1 || completion.statuses.length > 2
      || completion.statuses.some(code => code !== 200 && code !== 201)
      || new Set(completion.statuses).size !== completion.statuses.length
      || !plain(completion.json) || !same(Object.keys(completion.json).sort(), ['equals', 'field'])
      || typeof completion.json.field !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(completion.json.field)) return false
  const equals = completion.json.equals
  return typeof equals === 'boolean' || typeof equals === 'number' && Number.isFinite(equals)
    || typeof equals === 'string' && equals.length > 0 && equals.length <= 128
}

export function validateHttpInputContract(spec, args, def, descriptor) {
  const selected = def.fence?.textWrite?.format === HTTP_SELECTED_TEXT
  if (!httpTextWriteEligible(descriptor)
      || !same(spec.sourceTypes, ['http']) || spec.kind !== 'write'
      || !same(spec.params, descriptor.params) || !same(spec.returns, descriptor.returns)
      || !same(spec.fence, descriptor.fence) || !same(def.fence, descriptor.fence)
      || spec.fence?.textWrite?.relativePath !== def.entry)
    throw new Error('Action v2 has no matching pinned local HTTP text write Tool contract')
  if (!plain(spec.inputRoles)
      || !(selected ? spec.guardCatalogDigest === guardCatalogDigest
        : [guardCatalogDigest, legacyGuardCatalogDigest].includes(spec.guardCatalogDigest))
      || Object.hasOwn(spec, 'inputPolicy') || Object.hasOwn(spec.execution ?? {}, 'inputRoles')
      || Object.hasOwn(spec.execution ?? {}, 'guardCatalogDigest'))
    throw new Error('Action v2 HTTP write requires exact roles and guard catalog digest')
  const { targetParam, payloadParam } = def.fence.textWrite
  const bindings = spec.bindings ?? {}
  if (!plain(bindings) || Object.keys(bindings).some(name => name !== 'source' && name !== targetParam && name !== payloadParam)
      || !same(Object.keys(spec.inputRoles).sort(), [targetParam, payloadParam].filter(name => !Object.hasOwn(bindings, name)).sort()))
    throw new Error('Action v2 HTTP roles must cover the unbound target and payload')
  const target = spec.inputRoles[targetParam], payload = spec.inputRoles[payloadParam]
  if (Object.hasOwn(bindings, payloadParam) || !plain(payload)
      || !same(Object.keys(payload).sort(), ['guard', 'guardConfig', 'role'])
      || payload.role !== 'payload' || payload.guard !== (selected ? LOCAL_MATERIAL : TEXT)
      || !plain(payload.guardConfig)
      || (selected ? !same(payload.guardConfig, {})
        : !same(Object.keys(payload.guardConfig).sort(), ['maxBytes', 'mediaType'])
          || !Number.isSafeInteger(payload.guardConfig.maxBytes) || payload.guardConfig.maxBytes < 1
          || payload.guardConfig.maxBytes > 16_384 || payload.guardConfig.mediaType !== 'text/plain')
      || !Object.hasOwn(bindings, targetParam) && (!plain(target) || !same(target, { role: 'grounded' })))
    throw new Error('Action v2 HTTP target must be grounded and payload bounded text/plain')
  if (!plain(args) || !same(Object.keys(args).sort(), ['source', targetParam, payloadParam].sort())
      || typeof args.source !== 'string' || !args.source
      || typeof args[targetParam] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(args[targetParam])
      || args[targetParam] === '.' || args[targetParam] === '..'
      || (selected ? !plain(args[payloadParam])
        || !same(Object.keys(args[payloadParam]).sort(), ['digest', 'ref'])
        || !/^mat_[0-9a-f]{32}$/.test(args[payloadParam].ref)
        || !/^sha256:[0-9a-f]{64}$/.test(args[payloadParam].digest)
        : typeof args[payloadParam] !== 'string'
          || Buffer.byteLength(args[payloadParam], 'utf8') > payload.guardConfig.maxBytes
          || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(args[payloadParam])))
    throw new Error('Action v2 HTTP arguments violate the fixed target or text body')
  return true
}

export function inputAdoptionForTools(tools, sources, descriptors = [], { selectedMaterialReady = false } = {}) {
  // A manifest alone cannot make a located Adapter executable. The local Source
  // table must have a db record and DSN. Gateway independently checks governance.
  const readyDbSources = Object.entries(sources ?? {})
    .filter(([, record]) => record?.type === 'db' && typeof record.dsn === 'string' && record.dsn !== '')
    .map(([name]) => name).sort()
  const readyHttpSources = Object.entries(sources ?? {})
    .filter(([, record]) => record?.type === 'http' && typeof record.url === 'string'
      && (() => { try { const url = new URL(record.url); return ['http:', 'https:'].includes(url.protocol) && !!url.hostname } catch { return false } })())
    .map(([name]) => name).sort()
  if (readyDbSources.length === 0 && readyHttpSources.length === 0) return undefined
  const guardsByKind = {}
  const toolContractsByExec = {}
  const sourceNamesByExec = {}
  for (const descriptor of descriptors) {
    const def = tools[descriptor.id]
    if (!def) continue
    const db = ['read', 'write'].some(kind => eligible(def, kind) && descriptor.kind === kind)
    const http = httpTextWriteEligible(descriptor) && httpTextWriteEligible({
      ...def, kind: descriptor.kind, params: descriptor.params, returns: descriptor.returns })
      && (descriptor.fence.textWrite.format !== HTTP_SELECTED_TEXT || selectedMaterialReady && catalog.guards.some(guard => guard.id === LOCAL_MATERIAL))
    if (!db && !http) continue
    if (!same(descriptor.sourceTypes, def.sourceTypes)
        || !same(descriptor.params, def.params ?? {}) || !same(descriptor.returns, def.returns ?? [])
        || http && !same(descriptor.fence, def.fence)) continue
    const readySources = http ? readyHttpSources : readyDbSources
    if (readySources.length === 0) continue
    if (descriptor.kind === 'read') guardsByKind.read = [ENUM]
    else guardsByKind.write = [...new Set([...(guardsByKind.write ?? [ENUM]), http && descriptor.fence.textWrite.format === HTTP_SELECTED_TEXT
      ? LOCAL_MATERIAL : TEXT])]
    toolContractsByExec[descriptor.id] = toolContractFingerprint(descriptor)
    sourceNamesByExec[descriptor.id] = readySources
  }
  return Object.keys(guardsByKind).length === 0 ? undefined
    : { format: 'rulith-action-inputs/2', guardCatalogDigest, guardsByKind, toolContractsByExec, sourceNamesByExec }
}

export function validateDbInputContract(spec, args, def, descriptor) {
  if (spec.execution && (Object.hasOwn(spec.execution, 'inputRoles')
      || Object.hasOwn(spec.execution, 'guardCatalogDigest'))) throw new Error('Action inputRoles belong to the Action, not execution metadata')
  if (!Object.hasOwn(spec, 'inputRoles') && !Object.hasOwn(spec, 'guardCatalogDigest')) {
    // A legacy DB write can commit its SQL change and then fail the v1 returns parser.
    // The v2 fixed-SQL result and one-row phase must be present before any ClaimWork.
    if (spec.kind === 'write' && Array.isArray(spec.sourceTypes) && spec.sourceTypes.includes('db')) {
      throw new Error('Database write Action requires v2 input roles and guard catalog')
    }
    return false
  }
  if (!plain(spec.inputRoles) || ![guardCatalogDigest, legacyGuardCatalogDigest].includes(spec.guardCatalogDigest)
      || Object.hasOwn(spec, 'inputPolicy'))
    throw new Error('Action v2 requires exact roles and guard catalog digest')
  if (plain(spec.params) && Object.values(spec.params).some(type => typeof type === 'string' && type.endsWith('?')))
    throw new Error('Action v2 database Tool requires required scalar parameters; optional SQL slots are unsupported')
  if (!eligible(def, spec.kind) || !same(descriptor.sourceTypes, spec.sourceTypes)
      || !same(descriptor.params, spec.params) || !same(descriptor.returns, spec.returns)
      || descriptor.kind !== spec.kind || !same(spec.sourceTypes, ['db'])) {
    throw new Error('Action v2 has no matching pinned local database Tool contract')
  }
  if (!plain(args)) throw new Error('Action v2 args must be an object')
  const bindings = spec.bindings ?? {}
  if (!plain(bindings) || Object.keys(bindings).some(name => name !== 'source' && !Object.hasOwn(spec.params, name)))
    throw new Error('Action v2 bindings are invalid')
  const publicNames = Object.keys(spec.params).filter(name => !Object.hasOwn(bindings, name)).sort()
  if (!same(publicNames, Object.keys(spec.inputRoles).sort())) throw new Error('Action v2 roles must cover every unbound parameter')
  const roles = {}
  for (const name of Object.keys(spec.params)) {
    const declaration = spec.inputRoles[name]
    if (Object.hasOwn(bindings, name)) { roles[name] = 'grounded'; continue }
    if (!plain(declaration) || typeof declaration.role !== 'string') throw new Error(`Action v2 role for ${name} is invalid`)
    const { role, guard, guardConfig } = declaration
    if (Object.keys(declaration).some(key => !['role', 'guard', 'guardConfig'].includes(key)))
      throw new Error(`Action v2 role for ${name} has unknown fields`)
    roles[name] = role
    const omitted = !Object.hasOwn(args, name) && spec.params[name].endsWith('?')
    if (role === 'grounded' || role === 'clue') {
      if (guard !== undefined || guardConfig !== undefined || Object.keys(declaration).length !== 1
          || (role === 'clue' && spec.kind !== 'read')) throw new Error(`Action v2 role for ${name} is unsupported`)
    } else if (role === 'scoped' && guard === ENUM && plain(guardConfig)
        && Object.keys(guardConfig).length === 1 && Array.isArray(guardConfig.values)
        && guardConfig.values.length > 0 && new Set(guardConfig.values.map(v => JSON.stringify(v))).size === guardConfig.values.length) {
      const type = spec.params[name].replace(/\?$/, '')
      if (guardConfig.values.some(value => typeof value !== type)
          || (!omitted && !guardConfig.values.some(value => Object.is(value, args[name]))))
        throw new Error(`Action v2 enum value for ${name} is outside its exact type or range`)
    } else if (role === 'payload' && spec.kind === 'write' && guard === TEXT && plain(guardConfig)
        && Object.keys(guardConfig).length === 2 && Number.isSafeInteger(guardConfig.maxBytes)
        && guardConfig.maxBytes > 0 && typeof guardConfig.mediaType === 'string'
        && guardConfig.mediaType.length > 0 && guardConfig.mediaType.length <= 127
        && spec.params[name] === 'string') {
      if (!omitted && (typeof args[name] !== 'string' || Buffer.byteLength(args[name], 'utf8') > guardConfig.maxBytes))
        throw new Error(`Action v2 payload ${name} exceeds its UTF-8 byte limit`)
    } else throw new Error(`Action v2 guard for ${name} is unsupported`)
  }
  if (spec.kind === 'write') {
    const shape = fixedUpdateShape(def.entry)
    if (!shape || shape.where.some(name => roles[name] !== 'grounded')
        || shape.set.some(name => !['scoped', 'payload'].includes(roles[name])))
      throw new Error('Action v2 write requires grounded target/version in WHERE and guarded data in SET')
  }
  return true
}

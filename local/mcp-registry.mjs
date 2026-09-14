// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto'

export const REGISTRY_URL = 'https://registry.modelcontextprotocol.io'
const NPM_URL = 'https://registry.npmjs.org'
const NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const text = (value, limit = 1000) => typeof value === 'string' ? value.slice(0, limit) : ''
const link = value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined } catch { return undefined } }
const official = row => row?._meta?.['io.modelcontextprotocol.registry/official'] ?? {}
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null

/** Public metadata only: bounded reads, no Local credentials, no redirects to another registry. */
export async function registryJson(url, fetcher = fetch, timeoutMs = 25_000) {
  let status
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error', headers: { accept: 'application/json' } })
    status = response.status
    if (!response.ok) throw new Error('HTTP ' + response.status)
    const chunks = []; let length = 0
    for await (const chunk of response.body) {
      length += chunk.length
      if (length > 2_097_152) throw new Error('Metadata size limit')
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch { throw new Error('Directory metadata is unavailable or invalid' + (status >= 400 ? ' (HTTP ' + status + ')' : '') + '. Check connectivity and retry; no service was installed or started.') }
}

function identity(name, version) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.length > 250
    || typeof version !== 'string' || !version || version.length > 100 || /[\x00-\x1f]/.test(version)) throw new Error('Choose a named, versioned server from the directory.')
}

function summary(row) {
  const server = row?.server ?? {}
  identity(server.name, server.version)
  const options = optionsOf(server), supported = options.filter(option => !option.unsupported)
  const npm = supported.find(option => option.npmPackage)
  return { name: server.name, version: server.version, title: text(server.title || server.name, 150), description: text(server.description),
    repository: link(server.repository?.url), website: link(server.websiteUrl), status: official(row).status ?? 'unknown',
    publishedAt: timestamp(official(row).publishedAt), updatedAt: timestamp(official(row).updatedAt),
    setup: { supported: official(row).status === 'active' && supported.length > 0,
      local: supported.some(option => !option.remote), remote: supported.some(option => option.remote),
      reason: supported.length ? '' : options[0]?.unsupported || 'No installation option is declared.' },
    downloadPackage: npm?.npmPackage ?? null,
    formats: [...new Set([...(server.packages ?? []).map(p => p.registryType), ...(server.remotes ?? []).map(p => p.type)])] }
}

/** Convert Registry input templates into explicit operator fields, never executable shell text. */
export function configurationTemplate(descriptor, remote = false) {
  const fields = [], bindings = [], ids = new Set()
  const field = (id, input, label, repeated = false) => {
    if (ids.has(id)) throw new Error('Duplicate input names require manual configuration.')
    ids.add(id)
    fields.push({ id, label, description: text(input.description), required: input.isRequired === true,
      secret: input.isSecret === true, format: input.format ?? 'string', repeated,
      ...(Array.isArray(input.choices) ? { choices: input.choices } : {}),
      ...(!input.isSecret && typeof input.default === 'string' ? { default: input.default } : {}) })
  }
  const add = (id, input, target, label) => {
    if (!object(input)) throw new Error('Invalid input descriptor.')
    if ((input.value !== undefined && typeof input.value !== 'string') || (input.default !== undefined && typeof input.default !== 'string')
      || (input.choices !== undefined && (!Array.isArray(input.choices) || input.choices.some(value => typeof value !== 'string')))) throw new Error('Invalid configuration input declaration.')
    if (typeof input.value === 'string') {
      for (const [name, variable] of Object.entries(input.variables ?? {})) {
        if (!/^[A-Za-z0-9_-]+$/.test(name) || !object(variable)) throw new Error('Invalid template variable.')
        field(id + '.' + name, variable, label + ' · ' + name)
      }
      const placeholders = [...input.value.matchAll(/\{([^{}]+)\}/g)].map(match => match[1])
      if (placeholders.some(name => !Object.hasOwn(input.variables ?? {}, name))) throw new Error('Undeclared template variables require manual configuration.')
    } else {
      if (input.variables && Object.keys(input.variables).length) throw new Error('Variables without a value template require manual configuration.')
      field(id, input, label, input.isRepeated === true)
    }
    bindings.push({ id, input, target })
  }
  if (remote) {
    const endpoint = new URL(descriptor.url)
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || /[{}]/.test(descriptor.url)) throw new Error('Remote endpoints need a fixed HTTPS URL without credentials or placeholders.')
  }
  for (const [index, argument] of (descriptor.packageArguments ?? []).entries()) {
    if (!['named', 'positional'].includes(argument.type) || (argument.type === 'named' && !/^--?[A-Za-z0-9][A-Za-z0-9_-]*$/.test(argument.name))) throw new Error('Complex command flags require manual configuration.')
    add('arg.' + index, argument, { kind: 'argument', name: argument.type === 'named' ? argument.name : undefined }, argument.name || argument.valueHint || 'Argument ' + (index + 1))
  }
  for (const input of (remote ? descriptor.headers ?? [] : descriptor.environmentVariables ?? [])) {
    const name = input.name
    if (remote ? !/^[A-Za-z0-9-]+$/.test(name) || /^(host|connection|content-length|transfer-encoding|cookie|origin|proxy-authorization|accept|content-type|last-event-id|mcp-.*)$/i.test(name)
      : !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /^(RULITH_|NODE_OPTIONS$|NODE_PATH$|LD_|DYLD_|PATH$|PATHEXT$|COMSPEC$)/i.test(name)) throw new Error('Reserved environment or header name requires manual configuration.')
    add((remote ? 'header.' : 'env.') + name.toLowerCase(), input, { kind: remote ? 'header' : 'env', name }, name)
  }
  if (fields.length > 64 || bindings.length > 64) throw new Error('Too many configuration fields; configure this server manually.')
  return { fields, bindings }
}

export function resolveConfiguration(template, supplied = {}) {
  if (!object(supplied) || Object.keys(supplied).some(id => !template.fields.some(field => field.id === id))) throw new Error('Unexpected directory configuration fields.')
  const values = new Map()
  for (const field of template.fields) {
    let value = supplied[field.id] ?? field.default ?? ''
    if (field.repeated) {
      if (value === '') value = []
      if (!Array.isArray(value) || value.length > 32) throw new Error('Repeated inputs require a JSON array of at most 32 strings.')
    } else if (typeof value !== 'string') throw new Error('Configuration inputs must be strings.')
    const items = Array.isArray(value) ? value : [value]
    if (field.required && (!items.length || items.some(item => item === ''))) throw new Error('Complete required field: ' + field.label)
    for (const item of items) {
      if (typeof item !== 'string' || item.length > 8192 || /\x00/.test(item)) throw new Error('Invalid configuration value.')
      if (item && ((field.choices && !field.choices.includes(item)) || (field.format === 'boolean' && !['true', 'false'].includes(item))
        || (field.format === 'number' && (!item.trim() || !Number.isFinite(Number(item)))))) throw new Error('Invalid value for ' + field.label)
    }
    values.set(field.id, value)
  }
  const args = [], env = [], headers = []
  for (const { id, input, target } of template.bindings) {
    const value = typeof input.value === 'string'
      ? input.value.replace(/\{([^{}]+)\}/g, (_, name) => values.get(id + '.' + name) ?? '') : values.get(id)
    if (value === '' || (Array.isArray(value) && !value.length)) continue
    if (target.kind === 'argument') for (const item of Array.isArray(value) ? value : [value]) {
      if (target.name) args.push(target.name)
      args.push(item)
    } else if (target.kind === 'env') env.push([target.name, value])
    else {
      if (/[\r\n]/.test(value)) throw new Error('Headers cannot contain line breaks.')
      headers.push([target.name, value])
    }
  }
  return { args, env: Object.fromEntries(env), headers: Object.fromEntries(headers) }
}

function optionsOf(server) {
  const descriptors = [...(server.packages ?? []).map((value, index) => ({ id: 'package.' + index, value, remote: false })),
    ...(server.remotes ?? []).map((value, index) => ({ id: 'remote.' + index, value, remote: true }))]
  return descriptors.map(({ id, value, remote }) => {
    let template, unsupported
    try {
      if (remote ? value.type !== 'streamable-http' : value.registryType !== 'npm' || value.transport?.type !== 'stdio') throw new Error('Automatic setup supports npm / stdio and Streamable HTTP. Other formats require manual installation.')
      if (!remote) {
        if ((value.registryBaseUrl && value.registryBaseUrl.replace(/\/$/, '') !== NPM_URL) || (value.runtimeHint && value.runtimeHint !== 'npx')
          || (value.runtimeArguments ?? []).some(arg => arg.type !== 'positional' || !['-y', '--yes'].includes(arg.value)) || value.fileSha256) throw new Error('Custom runtimes, registries or file checksums require manual installation.')
        if (!NPM_PACKAGE.test(value.identifier ?? '')
          || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value.version ?? '')) throw new Error('Installation requires an exact npm package name and version.')
      }
      template = configurationTemplate(value, remote)
    } catch (error) { unsupported = error.message }
    return { id, label: remote ? value.type + ' · ' + text(value.url, 250) : value.registryType + ' · ' + value.identifier + '@' + value.version,
      unsupported, fields: template?.fields ?? [], descriptor: value, remote, template,
      npmPackage: !remote && value.registryType === 'npm' && NPM_PACKAGE.test(value.identifier ?? '') ? value.identifier : null }
  })
}

export function createMcpRegistry({ fetcher = fetch, now = Date.now } = {}) {
  const cache = new Map(), inflight = new Map()
  const get = async (url, fresh = false, timeoutMs = 25_000) => {
    const cached = cache.get(url)
    if (!fresh && cached && now() - cached.at < 300_000) return cached.value
    if (inflight.has(url)) return inflight.get(url)
    const request = registryJson(url, fetcher, timeoutMs).then(value => {
      if (cache.size >= 64) cache.delete(cache.keys().next().value)
      cache.set(url, { at: now(), value }); return value
    }).finally(() => inflight.delete(url))
    inflight.set(url, request); return request
  }
  const load = async (name, version, fresh = false) => {
    identity(name, version)
    const row = await get(REGISTRY_URL + '/v0.1/servers/' + encodeURIComponent(name) + '/versions/' + encodeURIComponent(version), fresh)
    if (row?.server?.name !== name || (version !== 'latest' && row?.server?.version !== version)) throw new Error('Registry returned a different server identity.')
    return row
  }
  return {
    async downloads(packageName) {
      if (typeof packageName !== 'string' || packageName.length > 214 || !NPM_PACKAGE.test(packageName)) throw new Error('Choose a valid npm package name.')
      const source = 'https://api.npmjs.org/downloads/point/last-month/' + encodeURIComponent(packageName)
      try {
        const value = await get(source, false, 5000)
        const day = input => typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input) && Number.isFinite(Date.parse(input)) && new Date(input).toISOString().slice(0, 10) === input
        if (value.package !== packageName || !Number.isSafeInteger(value.downloads) || value.downloads < 0
          || !day(value.start) || !day(value.end) || value.start > value.end) throw new Error('Invalid download statistics.')
        // npm 只提供包级下载次数；不汇总成服务用户数，也不作为安装或授权判据。
        return { package: packageName, status: 'available', downloads: value.downloads, start: value.start, end: value.end,
          fetchedAt: new Date(cache.get(source).at).toISOString(), source }
      } catch { return { package: packageName, status: 'unavailable', downloads: null, source } }
    },
    async search(query = '', cursor = '') {
      if (typeof query !== 'string' || query.length > 150 || typeof cursor !== 'string' || cursor.length > 1000) throw new Error('Search or cursor is too long.')
      const url = new URL(REGISTRY_URL + '/v0.1/servers')
      url.search = new URLSearchParams({ version: 'latest', limit: '4', ...(query.trim() ? { search: query.trim() } : {}), ...(cursor ? { cursor } : {}) })
      const result = await get(url.href)
      if (!Array.isArray(result.servers) || result.servers.length > 100) throw new Error('Invalid directory response.')
      return { provider: REGISTRY_URL, servers: result.servers.map(summary), nextCursor: text(result.metadata?.nextCursor, 1000) }
    },
    async detail(name, version = 'latest') {
      const row = await load(name, version)
      return { ...summary(row), reviewToken: digest(row), options: optionsOf(row.server).map(({ template, descriptor, ...view }) => view) }
    },
    async prepare({ serverName, version, optionId, reviewToken, values }) {
      const row = await load(serverName, version, true)
      if (official(row).status !== 'active') throw new Error('This server is not active in the directory. Installation is refused.')
      if (digest(row) !== reviewToken) throw new Error('Directory metadata changed. Reopen details and review the current version before installing.')
      const option = optionsOf(row.server).find(option => option.id === optionId)
      if (!option || option.unsupported) throw new Error(option?.unsupported || 'Select a supported directory installation option.')
      const configuration = resolveConfiguration(option.template, values)
      const provenance = { provider: REGISTRY_URL, name: serverName, version: row.server.version, optionId, reviewToken }
      if (option.remote) return { source: { type: 'mcp', transport: 'streamable-http', url: option.descriptor.url, headers: configuration.headers }, provenance }
      const pkg = option.descriptor
      const metadata = await get(NPM_URL + '/' + encodeURIComponent(pkg.identifier) + '/' + encodeURIComponent(pkg.version), true)
      if (metadata.name !== pkg.identifier || metadata.version !== pkg.version || metadata.mcpName !== serverName) throw new Error('npm package identity does not match the Registry publisher declaration.')
      const bins = typeof metadata.bin === 'string' ? [metadata.bin] : object(metadata.bin) ? [...new Set(Object.values(metadata.bin))] : []
      if (bins.length !== 1 || typeof bins[0] !== 'string' || /(^\/|\\|(^|\/)\.\.(\/|$)|:)/.test(bins[0]) || !bins[0]) throw new Error('Package needs one unambiguous Node.js executable; otherwise install and configure it manually.')
      if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(metadata.dist?.integrity ?? '')) throw new Error('npm package has no supported SHA-512 integrity.')
      const entry = { id: digest([serverName, pkg.identifier, pkg.version, metadata.dist.integrity]).slice(0, 24),
        package: pkg.identifier, version: pkg.version, entry: bins[0], integrity: metadata.dist.integrity, serverName }
      return { entry, configuration, provenance: { ...provenance, package: entry.package, packageVersion: entry.version, integrity: entry.integrity } }
    },
  }
}

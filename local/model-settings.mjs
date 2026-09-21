// SPDX-License-Identifier: Apache-2.0
/**
 * Account-scoped model defaults for the Local manager.
 *
 * This deliberately is not part of manager-registry.json.  The registry is returned to the
 * manager page; provider keys must remain in an operator-only, 0600 file instead.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic } from './manager-registry.mjs'

const text = value => typeof value === 'string' ? value : ''
const clean = value => text(value).trim()

export const modelDefaultsFile = root => join(root, 'model-defaults.json')

export function modelUrl(raw) {
  const url = new URL(clean(raw))
  if (url.username || url.password || url.search || url.hash
    || !(url.protocol === 'https:' || url.protocol === 'http:' && isLoopback(url))) {
    throw new Error('Provide a model name and HTTPS endpoint, or a local HTTP endpoint.')
  }
  return url
}

export function isLoopback(url) {
  return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
}

export function modelReady({ url, name, key } = {}) {
  if (!clean(url) || !clean(name)) return false
  try {
    const parsed = modelUrl(url)
    return clean(key) !== '' || isLoopback(parsed)
  } catch { return false }
}

/** Public view: never put a key, digest, or an opaque proxy for a key on a status route. */
export function modelView({ source = 'custom', url = '', name = '', key = '', thinking = 'standard' } = {}) {
  const configured = modelReady({ url, name, key })
  return {
    source,
    url: clean(url),
    name: clean(name),
    thinking: thinking === 'enabled' ? 'enabled' : 'standard',
    keyConfigured: clean(key) !== '',
    configured,
    ready: configured,
    reason: configured ? '' : 'Provide a model endpoint, name, and key (a local loopback endpoint may omit the key).',
  }
}

export function modelSignature({ url = '', name = '', key = '', thinking = 'standard' } = {}) {
  return createHash('sha256').update(`${clean(url)}\u0000${clean(name)}\u0000${clean(key)}\u0000${thinking === 'enabled' ? 'enabled' : 'standard'}`).digest('hex')
}

function load(file) {
  if (!existsSync(file)) return { version: 1, defaults: [] }
  const value = JSON.parse(readFileSync(file, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.defaults)) {
    throw new Error(`Model defaults at ${file} cannot be read. Nothing was changed.`)
  }
  return { version: 1, defaults: value.defaults.filter(row => row && typeof row === 'object' && !Array.isArray(row)) }
}

export function createModelSettings({ root }) {
  const file = modelDefaultsFile(root)
  const read = (origin, accountId) => {
    const row = load(file).defaults.find(entry => entry.origin === origin && entry.accountId === accountId)
    return row === undefined ? undefined : { ...row }
  }
  const save = (origin, accountId, value) => {
    const state = load(file)
    const index = state.defaults.findIndex(entry => entry.origin === origin && entry.accountId === accountId)
    const next = { origin, accountId, ...value }
    if (index < 0) state.defaults.push(next)
    else state.defaults[index] = next
    writeJsonAtomic(file, state, 0o600)
    return next
  }
  return { file, read, save }
}

/** Validate an API model write without deciding how an omitted key is inherited. */
export function checkedModelInput(body, { requireUrlAndName = true } = {}) {
  const urlText = clean(body.url)
  const name = clean(body.name)
  if (requireUrlAndName && (!urlText || !name || name.length > 256)) {
    throw new Error('Provide a model name and HTTPS endpoint, or a local HTTP endpoint.')
  }
  const url = requireUrlAndName ? modelUrl(urlText) : undefined
  if (body.key !== undefined && (typeof body.key !== 'string' || body.key.length > 4096)) {
    throw new Error('Provide a model key of at most 4096 characters.')
  }
  if (body.clearKey !== undefined && body.clearKey !== true && body.clearKey !== false) throw new Error('clearKey must be true or false.')
  if (body.clearKey === true && clean(body.key) !== '') throw new Error('Choose either a replacement model key or clear it.')
  if (body.thinking !== undefined && !['enabled', 'standard', ''].includes(text(body.thinking))) {
    throw new Error('Thinking must be enabled or standard.')
  }
  return { url: url?.href ?? '', name, key: body.key, clearKey: body.clearKey === true,
    thinking: body.thinking === 'enabled' ? 'enabled' : 'standard' }
}

/** A blank key preserves only a credential for the same provider origin. */
export function resolvedKey(previous, nextUrl, input) {
  if (input.clearKey) return ''
  if (clean(input.key) !== '') return input.key
  try {
    return previous && new URL(previous.url).origin === new URL(nextUrl).origin ? text(previous.key) : ''
  } catch { return '' }
}

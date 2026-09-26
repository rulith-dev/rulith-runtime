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
export const DEFAULT_MODEL_URL = 'https://api.anthropic.com/v1/messages'
export const DEFAULT_MAX_OUTPUT_TOKENS = 6000
const MIN_OUTPUT_TOKENS = 256
const MAX_OUTPUT_TOKENS = 65536
export function maxOutputTokens(value) {
  if (value === undefined || value === '') return DEFAULT_MAX_OUTPUT_TOKENS
  const digits = typeof value === 'string' && /^[0-9]+$/.test(value)
  if (!(typeof value === 'number' || digits) || !Number.isSafeInteger(Number(value))
    || Number(value) < MIN_OUTPUT_TOKENS || Number(value) > MAX_OUTPUT_TOKENS) {
    throw new Error('Maximum output tokens must be an integer from 256 to 65536.')
  }
  return Number(value)
}

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
export function modelView({ source = 'custom', url = '', name = '', key = '', thinking = 'standard', maxOutputTokens: budget } = {}) {
  let outputBudget, budgetError = ''
  try { outputBudget = maxOutputTokens(budget) } catch (error) { budgetError = error.message }
  const configured = modelReady({ url, name, key }) && !budgetError
  return {
    source,
    url: clean(url),
    name: clean(name),
    thinking: ['enabled', 'disabled'].includes(thinking) ? thinking : 'standard',
    maxOutputTokens: outputBudget ?? null,
    keyConfigured: clean(key) !== '',
    configured,
    ready: configured,
    reason: configured ? '' : budgetError || 'Provide a model endpoint, name, and key (a local loopback endpoint may omit the key).',
  }
}

export function modelSignature({ url = '', name = '', key = '', thinking = 'standard', maxOutputTokens: budget } = {}) {
  let outputBudget
  try { outputBudget = maxOutputTokens(budget) } catch { outputBudget = `invalid:${typeof budget}:${String(budget)}` }
  return createHash('sha256').update(`${clean(url)}\u0000${clean(name)}\u0000${clean(key)}\u0000${['enabled', 'disabled'].includes(thinking) ? thinking : 'standard'}\u0000${outputBudget}`).digest('hex')
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
  if (body.thinking !== undefined && !['enabled', 'disabled', 'standard', ''].includes(text(body.thinking))) {
    throw new Error('Thinking must be enabled, disabled, or standard.')
  }
  if (body.maxOutputTokens !== undefined && (!Number.isInteger(body.maxOutputTokens)
    || body.maxOutputTokens < MIN_OUTPUT_TOKENS || body.maxOutputTokens > MAX_OUTPUT_TOKENS)) {
    throw new Error('Maximum output tokens must be an integer from 256 to 65536.')
  }
  if (url?.pathname.replace(/\/+$/, '').endsWith('/messages') && ['enabled', 'disabled'].includes(body.thinking)) {
    throw new Error('Choose Provider default for a Messages endpoint. Explicit thinking controls require an OpenAI-compatible Chat Completions endpoint.')
  }
  return { url: url?.href ?? '', name, key: body.key, clearKey: body.clearKey === true,
    thinking: ['enabled', 'disabled'].includes(body.thinking) ? body.thinking : 'standard',
    maxOutputTokens: body.maxOutputTokens }
}

/** A blank key preserves only a credential for the same provider origin. */
export function resolvedKey(previous, nextUrl, input) {
  if (input.clearKey) return ''
  if (clean(input.key) !== '') return input.key
  try {
    return previous && new URL(previous.url).origin === new URL(nextUrl).origin ? text(previous.key) : ''
  } catch { return '' }
}

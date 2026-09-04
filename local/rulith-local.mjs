#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Rulith Local is one host with Agent, Worker, or Agent+Worker modes.
 * Roles remain separate child processes with separate credentials. Local owns
 * only lifecycle, a bounded diagnostic journal, and its loopback UI.
 */
import http from 'node:http'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { localPage } from './local-ui.mjs'

const IS_MAIN = import.meta.url === pathToFileURL(process.argv[1] ?? '').href
const HERE = dirname(fileURLToPath(import.meta.url))
const ROLE_SET = new Set(['agent', 'worker'])
const MAX_BODY = 64 * 1024

/** Local owns both sides of each port connection, so it validates once and gives the
 * parent and child the same integer. Falling back independently lets the Agent listen on
 * 7799 while Local keeps calling NaN or another value. */
export function localInteger(name, raw, fallback, { min = 1, max = 65_535 } = {}) {
  if (raw === undefined || String(raw).trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}; received ${JSON.stringify(String(raw))}.`)
  }
  return value
}

export function rolesOf(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').replaceAll('+', ',').split(',')
  const roles = [...new Set(raw.map((role) => String(role).trim()).filter(Boolean))]
  if (roles.length === 0 || roles.some((role) => !ROLE_SET.has(role))) throw new Error('roles must contain agent, worker, or both.')
  return roles
}

export function modeOf(roles) {
  const selected = rolesOf(roles)
  return selected.length === 2 ? 'agent+worker' : selected[0]
}

export function rolesFromArgs(args, fallback) {
  const input = [...args]
  if (input[0] === 'start') input.shift()
  if (input.includes('--help') || input.includes('-h')) return null
  let chosen
  for (let i = 0; i < input.length; i++) {
    if ((input[i] === '--role' || input[i] === '--roles') && input[i + 1] !== undefined) { chosen = input[++i]; continue }
    throw new Error(`Unknown Rulith Local option: ${input[i]}`)
  }
  return rolesOf(chosen ?? fallback)
}

export function defaultLocalConfig() {
  return {
    roles: ['agent', 'worker'],
    agent: { args: [], env: {
      RULITH_URL: 'https://api.rulith.ai', RULITH_TOKEN: '',
      RULITH_MODEL_URL: 'https://api.anthropic.com/v1/messages', RULITH_MODEL: 'claude-sonnet-5', RULITH_MODEL_KEY: '',
    } },
    worker: { env: { RULITH_WORK_URL: 'https://api.rulith.ai/work', RULITH_CONNECTION: '', RULITH_CONNECTION_KEY: '' } },
    paths: {},
  }
}

export function defaultConfigPath(home = homedir()) { return join(home, '.rulith', 'local.json') }

export function normalizeLocalConfig(config) {
  const defaults = defaultLocalConfig()
  const { cloud: _retiredCloud, ...current } = config ?? {}
  const agentEnv = { ...defaults.agent.env, ...(config?.agent?.env ?? {}) }
  delete agentEnv.RULITH_AGENT
  return {
    ...defaults, ...current,
    roles: rolesOf(config?.roles ?? defaults.roles),
    agent: { ...defaults.agent, ...(config?.agent ?? {}), env: agentEnv },
    worker: { ...defaults.worker, ...(config?.worker ?? {}), env: { ...defaults.worker.env, ...(config?.worker?.env ?? {}) } },
    paths: { ...defaults.paths, ...(config?.paths ?? {}) },
  }
}

/** Non-empty deployment config wins; an empty placeholder means "inherit".
 * Generated example files intentionally contain blank credential slots, and
 * those blanks must not erase secrets supplied by the process supervisor. */
export function effectiveChildEnv(base, configured = {}) {
  const overlay = Object.fromEntries(Object.entries(configured).filter(([, value]) => String(value ?? '').trim() !== ''))
  return { ...base, ...overlay }
}

function loadConfig(configFile) {
  if (!existsSync(configFile)) {
    const config = defaultLocalConfig()
    mkdirSync(dirname(resolve(configFile)), { recursive: true, mode: 0o700 })
    writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 })
    console.log(`Created ${configFile}. Add credentials for the selected roles, then restart Rulith Local.`)
    return config
  }
  const raw = JSON.parse(readFileSync(configFile, 'utf8'))
  const config = normalizeLocalConfig(raw)
  if (raw.cloud !== undefined || raw.agent?.env?.RULITH_AGENT !== undefined) {
    saveConfig(configFile, config)
    console.warn('Removed retired Cloud-session or Agent-selector fields. The configured MCP token is now the only Agent identity source.')
  }
  return config
}

function saveConfig(configFile, config) {
  mkdirSync(dirname(resolve(configFile)), { recursive: true, mode: 0o700 })
  writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 })
}

const readJson = (req) => new Promise((accept, reject) => {
  const chunks = []
  let size = 0
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > MAX_BODY) { reject(new Error('Request body exceeds 64KB.')); req.destroy(); return }
    chunks.push(chunk)
  })
  req.on('end', () => {
    try { accept(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { reject(new Error('Body is not valid JSON.')) }
  })
})

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
const safeUrl = (value) => {
  try {
    const url = new URL(String(value ?? ''))
    url.username = ''; url.password = ''; url.search = ''; url.hash = ''
    return url.toString()
  } catch { return String(value ?? '') }
}

export function createLocalHost({ configFile, config, roles, port = 7790, key = randomUUID().replace(/-/g, '') }) {
  const selectedRoles = rolesOf(roles)
  const configDir = dirname(resolve(configFile))
  const events = []
  const clients = new Set()
  let nextSequence = 1
  const components = {
    agent: { child: null, serveKey: '', servePort: 7799, maxConcurrentCases: 1, agentId: 'unconfigured' },
    worker: { child: null },
  }
  const running = (role) => components[role].child !== null && components[role].child.exitCode === null
  const emit = (src, type, data = {}) => {
    const event = { sequence: nextSequence++, t: Date.now(), src, type, ...data }
    events.push(event)
    if (events.length > 2000) events.splice(0, events.length - 1500)
    const frame = `data: ${JSON.stringify(event)}\n\n`
    for (const client of clients) { try { client.write(frame) } catch { clients.delete(client) } }
  }
  const wireChild = (src, child) => {
    child.on('message', (message) => {
      if (message?.protocol !== 'rulith-local-event') return
      const event = message.event
      if (event === null || typeof event !== 'object' || Array.isArray(event)) return
      if (src === 'agent' && event.type === 'start' && Number.isInteger(event.concurrency)
        && event.concurrency >= 1 && event.concurrency <= 8) components.agent.maxConcurrentCases = event.concurrency
      if (src === 'agent' && event.type === 'start' && typeof event.agentId === 'string' && event.agentId.trim() !== '') {
        components.agent.agentId = event.agentId
      }
      const { type: _type, t: _time, ...rest } = event
      emit(src, event.type ?? 'log', { ...rest, at: event.t })
    })
    const buffers = { out: '', err: '' }
    const feed = (stream, chunk) => {
      buffers[stream] += chunk
      let boundary
      while ((boundary = buffers[stream].indexOf('\n')) >= 0) {
        const line = buffers[stream].slice(0, boundary)
        buffers[stream] = buffers[stream].slice(boundary + 1)
        if (line.trim() !== '') {
          emit(src, 'log', { line: line.slice(0, 400), ...(stream === 'err' ? { stderr: true } : {}) })
          if (stream === 'err') console.error(`[${src}] ${line.slice(0, 400)}`)
        }
      }
    }
    child.stdout.on('data', (chunk) => feed('out', String(chunk)))
    child.stderr.on('data', (chunk) => feed('err', String(chunk)))
  }
  const startAgent = () => {
    if (running('agent')) return 'Agent is already running.'
    const path = config.paths?.agent ? resolve(configDir, config.paths.agent) : resolve(HERE, '../agent/rulith-agent.mjs')
    if (!existsSync(path)) return `Agent runtime not found at ${path}. Set paths.agent in the Rulith Local configuration.`
    const serveKey = randomUUID().replace(/-/g, '')
    const roleEnv = effectiveChildEnv(process.env, config.agent?.env ?? {})
    const servePort = localInteger(
      'RULITH_SERVE_PORT',
      roleEnv.RULITH_SERVE_PORT,
      7799,
    )
    const args = Array.isArray(config.agent?.args) ? [...config.agent.args] : []
    if (!args.includes('--serve')) args.push('--serve')
    const child = spawn(process.execPath, [path, ...args], {
      env: { ...roleEnv, RULITH_LOCAL_EVENTS: 'ipc', RULITH_SERVE_KEY: serveKey, RULITH_SERVE_PORT: String(servePort) },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    components.agent = { ...components.agent, child, serveKey, servePort,
      maxConcurrentCases: localInteger(
        'RULITH_SERVE_CONCURRENCY',
        roleEnv.RULITH_SERVE_CONCURRENCY,
        1,
        { min: 1, max: 8 },
      ) }
    wireChild('agent', child)
    child.on('exit', (code) => { emit('agent', 'exit', { code }); components.agent.child = null })
    emit('agent', 'spawn', { pid: child.pid })
    return null
  }
  const startWorker = () => {
    if (running('worker')) return 'Worker is already running.'
    const path = config.paths?.worker ? resolve(configDir, config.paths.worker) : resolve(HERE, '../worker/rulith-worker.mjs')
    if (!existsSync(path)) return `Worker runtime not found at ${path}. Set paths.worker in the Rulith Local configuration.`
    const roleEnv = effectiveChildEnv(process.env, config.worker?.env ?? {})
    const child = spawn(process.execPath, [path], {
      env: { ...roleEnv, RULITH_LOCAL_CONFIG: resolve(configFile), RULITH_LOCAL_EVENTS: 'ipc' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], cwd: dirname(path),
    })
    components.worker.child = child
    wireChild('worker', child)
    child.on('exit', (code) => { emit('worker', 'exit', { code }); components.worker.child = null })
    emit('worker', 'spawn', { pid: child.pid })
    return null
  }
  const stop = (role) => {
    const child = components[role]?.child
    if (child === null || child === undefined) return `${role} is not running.`
    child.kill()
    return null
  }
  /**
   * One gate for every route, including `/`.
   *
   * `/` used to be served ahead of this function and had the per-run key substituted
   * into the page body, so any process on the machine could read the key with a single
   * unauthenticated `curl 127.0.0.1:7790/` — and, because the Host check also lives
   * here, a page reached through a rebound DNS name was served the key too. Loopback is
   * not a user boundary: every other local account, every other application, and any
   * process a browser page can talk to shares it.
   *
   * The key now travels the same way for the page as for the data routes: in the URL
   * the CLI prints. A missing or wrong key is 401 (this request did not authenticate);
   * a bad Origin or Host is 403 (authenticated shape, refused context).
   */
  const gate = (req) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const presented = req.headers['x-rulith-local'] ?? url.searchParams.get('k') ?? ''
    if (presented !== key) return { status: 401, teaching: 'Missing or invalid Rulith Local key. Open the URL printed at startup, which carries ?k=<key>.' }
    const origin = req.headers.origin
    if (origin !== undefined && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return { status: 403, teaching: `Cross-origin request rejected (Origin: ${origin}).` }
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(String(req.headers.host ?? ''))) return { status: 403, teaching: 'Non-local Host rejected to prevent DNS rebinding.' }
    return null
  }
  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    try {
      const denied = gate(req)
      if (denied !== null) return void json(res, denied.status, { ok: false, teaching: denied.teaching })
      if (path === '/' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        // The page carries no embedded secret. It reads the key from its own URL, so a
        // response that escapes the gate would still not hand anyone a working key.
        return void res.end(localPage)
      }
      if (path === '/events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
        clients.add(res); req.on('close', () => clients.delete(res)); return
      }
      if (path === '/status' && req.method === 'GET') {
        const agentEnv = effectiveChildEnv(process.env, config.agent?.env ?? {})
        const workerEnv = effectiveChildEnv(process.env, config.worker?.env ?? {})
        return void json(res, 200, {
          ok: true, mode: modeOf(selectedRoles), roles: selectedRoles,
          agent: running('agent'), worker: running('worker'), maxConcurrentCases: components.agent.maxConcurrentCases,
          runtime: {
            configFile,
            agent: {
              id: components.agent.agentId, credentialConfigured: String(agentEnv.RULITH_TOKEN ?? '') !== '',
              modelService: safeUrl(agentEnv.RULITH_MODEL_URL), model: String(agentEnv.RULITH_MODEL ?? ''),
              modelKeyConfigured: String(agentEnv.RULITH_MODEL_KEY ?? process.env.ANTHROPIC_API_KEY ?? '') !== '',
              thinking: String(agentEnv.RULITH_MODEL_THINKING ?? '') === 'enabled' ? 'extended' : 'standard',
              concurrency: components.agent.maxConcurrentCases,
            },
            worker: {
              connection: String(workerEnv.RULITH_CONNECTION ?? ''), credentialConfigured: String(workerEnv.RULITH_CONNECTION_KEY ?? '') !== '',
              workspaceTools: String(workerEnv.RULITH_WORKSPACE_TOOLS ?? 'read'),
              toolsFile: String(workerEnv.RULITH_TOOLS_FILE ?? ''), sourcesFile: String(workerEnv.RULITH_SOURCES_FILE ?? ''),
            },
          },
        })
      }
      if (path === '/control' && req.method === 'POST') {
        const body = await readJson(req)
        const role = String(body.role ?? '')
        let error = !selectedRoles.includes(role)
          ? `${role} is not enabled in mode ${modeOf(selectedRoles)}.`
          : body.operation === 'stop' ? stop(role)
            : body.operation === 'start' ? (role === 'agent' ? startAgent() : role === 'worker' ? startWorker() : 'role must be agent or worker.')
              : 'operation must be start or stop.'
        if (error === null && body.operation === 'start') {
          await new Promise((accept) => setTimeout(accept, 350))
          if (!running(role)) error = `${role === 'agent' ? 'Agent' : 'Worker'} exited during startup. Open Trace for the exact diagnostic and fix the missing local configuration before retrying.`
        }
        return void json(res, error === null ? 200 : 400, error === null ? { ok: true } : { ok: false, teaching: error })
      }
      if (path === '/cases' && req.method === 'POST') {
        if (!running('agent')) return void json(res, 409, { ok: false, teaching: 'This Local runtime is not running the Agent role.' })
        const body = await readJson(req)
        const sessionKey = String(body.sessionKey ?? '').trim() || `ctx-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`
        const response = await fetch(`http://127.0.0.1:${components.agent.servePort}/task`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-rulith-serve': components.agent.serveKey },
          body: JSON.stringify({ text: String(body.text ?? ''), sessionKey,
            ...(body.caseId === undefined ? {} : { caseId: body.caseId }),
            ...(body.caseType === undefined ? {} : { caseType: body.caseType }),
            ...(body.businessKey === undefined ? {} : { businessKey: body.businessKey }) }),
        }).catch(() => undefined)
        if (response === undefined) return void json(res, 502, { ok: false, teaching: 'The Agent task endpoint did not respond.' })
        return void json(res, response.status, await response.json().catch(() => ({ ok: response.ok })))
      }
      json(res, 404, { ok: false, teaching: 'Endpoint not found.' })
    } catch (error) { json(res, 400, { ok: false, teaching: String(error?.message ?? error) }) }
  })
  return {
    key, port, mode: modeOf(selectedRoles), roles: selectedRoles,
    status: () => ({ mode: modeOf(selectedRoles), roles: selectedRoles, agent: running('agent'), worker: running('worker') }),
    events: () => events.map((event) => ({ ...event })),
    listen: () => new Promise((accept, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        for (const role of selectedRoles) {
          const error = role === 'agent' ? startAgent() : startWorker()
          if (error !== null) {
            emit('local', 'error', { role, note: error })
            console.error(`[${role}] ${error}`)
          }
        }
        emit('local', 'start', { mode: modeOf(selectedRoles), roles: selectedRoles })
        accept()
      })
    }),
    close: async () => {
      const exits = []
      for (const role of ['agent', 'worker']) if (running(role)) {
        const child = components[role].child
        exits.push(new Promise((accept) => {
          const timer = setTimeout(accept, 1000)
          child.once('exit', () => { clearTimeout(timer); accept() })
        }))
        stop(role)
      }
      await Promise.all(exits)
      await new Promise((accept) => server.close(accept))
    },
  }
}

if (IS_MAIN) {
  const port = localInteger('RULITH_LOCAL_PORT', process.env.RULITH_LOCAL_PORT, 7790)
  const key = (process.env.RULITH_LOCAL_KEY ?? '').trim() || randomUUID().replace(/-/g, '')
  if (process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h')) {
    console.log('Rulith Local\n\nUsage:\n  rulith start [--role agent|worker|agent+worker]\n\nThe configured roles are used when --role is omitted. Configuration defaults to ~/.rulith/local.json.')
    process.exit(0)
  }
  const configFile = process.env.RULITH_LOCAL_CONFIG ?? defaultConfigPath()
  const config = loadConfig(configFile)
  let roles
  try { roles = rolesFromArgs(process.argv.slice(2), config.roles) } catch (error) { console.error(error.message); process.exit(1) }
  const host = createLocalHost({ configFile, config, roles, port, key })
  await host.listen()
  console.log(`Rulith Local · mode ${host.mode}`)
  console.log(`Local UI: http://127.0.0.1:${host.port}/?k=${host.key}`)
  console.log(`Configuration: ${resolve(configFile)} · secret values never leave this host.`)
  process.on('SIGINT', async () => { await host.close(); process.exit(0) })
}
